/*
 * EZER AI ↔ Agent OS Bridge Server (Port 4825)
 *
 * HTTP bridge for external integrations (EZER, A.U platform, etc.) to talk
 * to a running Agent OS instance. Endpoints:
 *   GET  /ping                    — health check + version + brain stats
 *   POST /api/exam                — single-shot question evaluation
 *   POST /api/evaluate            — A.U benchmark answer with chat injection
 *   GET  /api/evaluate-history    — score chat history with JSON output
 *   POST /api/brain-inject        — inject markdown note into 00_Raw/<date>/
 *   POST /api/skill-inject        — install Python tool into agent's tools/
 *   POST /api/template-inject     — install template pack into 40_템플릿/
 *
 * Extracted from extension.ts. Provides `startBridgeServer()` which owns the
 * full lifecycle: server creation, port-conflict probe + auto-takeover,
 * retry guard, and status messaging. Behaviour preserved byte-for-byte from
 * the original inline block.
 */

import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { ask } from '../llm';
import { safeBasename } from './path-safety';
import {
    CONNECT_AI_VERSION,
    versionLessThan,
    probeExistingBridge,
    readRequestBody,
} from './system';
import { killProcessesOnPort } from './process';
import { _getBrainDir, _isBrainDirExplicitlySet, getCompanyDir } from '../paths';
import { AGENTS, AGENT_ORDER } from '../agents';
import type { SidebarChatProvider } from '../views/sidebar-chat';

/* Type for the cross-cutting deps from extension.ts. Keeps the module
   loosely coupled — extension.ts wires its versions in at activate() time. */
export interface BridgeServerDeps {
    provider: SidebarChatProvider;
    getConfig: () => { maxTreeFiles: number; timeout: number; localBrainPath: string };
    ensureBrainDir: () => Promise<string | null>;
    getCompanyMetrics: () => { knowledgeInjected?: number; [k: string]: any };
    updateCompanyMetrics: (updates: { knowledgeInjected?: number; [k: string]: any }) => void;
    safeGitAutoSync: (dir: string, message: string, provider: SidebarChatProvider) => void;
    ensureCompanyStructure: () => void;
}

export function startBridgeServer(deps: BridgeServerDeps): void {
    const {
        provider,
        getConfig,
        ensureBrainDir,
        getCompanyMetrics,
        updateCompanyMetrics,
        safeGitAutoSync,
        ensureCompanyStructure,
    } = deps;

    try {
        const server = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            if (req.method === 'GET' && req.url === '/ping') {
                const brainDir = _getBrainDir();
                const brainCount = fs.existsSync(brainDir) ? provider._findBrainFiles(brainDir).length : 0;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                /* v2.89.127 — 신원·버전 정보 추가. 다른 Agent OS 인스턴스가 충돌 시
                   이 응답 보고 "우리 거다 → 조용히 공유 모드 / 옛 버전이면 자동 인계" 판단. */
                res.end(JSON.stringify({
                    status: 'ok',
                    msg: 'Agent OS Bridge Ready',
                    app: 'connect-ai-bridge',
                    version: CONNECT_AI_VERSION,
                    pid: process.pid,
                    config: getConfig(),
                    brain: { fileCount: brainCount, enabled: provider._brainEnabled }
                }));
            }
            else if (req.method === 'POST' && req.url === '/api/exam') {
                (async () => {
                    try {
                        const body = await readRequestBody(req);
                        const parsed = JSON.parse(body);
                        const promptStr = typeof parsed.prompt === 'string' ? parsed.prompt : '자동 접수된 문제';

                        // 웹사이트에서 전송된 문제를 Agent OS 채팅창으로 실시간 보고
                        provider.sendPromptFromExtension(`[A.U 입학시험 수신] ${promptStr}`);

                        // Claude CLI 로 문제를 전달하여 답안을 받아옴
                        const responseText = await ask(promptStr, 'standard', { timeoutMs: getConfig().timeout });

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, rawOutput: responseText }));
                    } catch (e: any) {
                        const status = e.message === 'BODY_TOO_LARGE' ? 413 : 500;
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }

            else if (req.method === 'POST' && req.url === '/api/evaluate') {
                (async () => {
                    try {
                        const body = await readRequestBody(req);
                        const parsed = JSON.parse(body);
                        const promptStr = typeof parsed.prompt === 'string' ? parsed.prompt : '';
                        if (!promptStr) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'prompt 필드가 비어 있습니다.' }));
                            return;
                        }

                        const fullPrompt = `당신은 주어진 문제에 대해 오직 정답과 풀이 과정만을 도출하는 AI 에이전트입니다.\n\n[문제]\n${promptStr}\n\n위 문제에 대해 핵심 풀이와 정답만 답변하십시오.`;

                        if ((provider as any).injectSystemMessage) {
                            (provider as any).injectSystemMessage(`**[A.U 벤치마크 문항 수신 완료]**\n\nAI 에이전트가 백그라운드에서 다음 문항을 전력으로 해결하고 있습니다...\n> _"${promptStr.substring(0, 60)}..."_`);
                        }

                        let responseText = "";
                        try {
                            responseText = await ask(fullPrompt, 'standard', { timeoutMs: getConfig().timeout });
                        } catch (apiErr: any) {
                            const msg = apiErr?.message || String(apiErr);
                            const errDetail = /timed out|timeout/i.test(msg)
                                ? `⏱ Claude 가 시간 안에 답을 못 냈어요. requestTimeout 을 늘리거나 질문을 짧게 줄여보세요.`
                                : /ENOENT|not found/i.test(msg)
                                ? `🔌 Claude CLI 를 못 찾았어요. \`claude --version\` 으로 설치 확인하거나 settings.json 의 \`agentOs.claudeBinPath\` 를 설정하세요.`
                                : `Claude 호출 실패: ${msg}`;
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: errDetail }));
                            return;
                        }

                        if((provider as any).injectSystemMessage) {
                            (provider as any).injectSystemMessage(`**[답안 작성 완료]**\n\n${responseText.length > 200 ? responseText.substring(0, 200) + '...' : responseText}\n\n👉 **답안이 A.U 플랫폼 서버로 전송되었습니다. 채점은 플랫폼에서 진행됩니다.**`);
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ rawOutput: responseText }));
                    } catch (e: any) {
                        const status = e.message === 'BODY_TOO_LARGE' ? 413 : 500;
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }
            else if (req.method === 'GET' && req.url === '/api/evaluate-history') {
                (async () => {
                    try {
                        const historyText = provider.getHistoryText();
                        if(!historyText || historyText.length < 50) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: "채점할 대화 내역이 충분하지 않습니다. 안티그래비티에서 에이전트와 먼저 시험을 진행하세요." }));
                            return;
                        }

                        provider.sendPromptFromExtension(`[A.U 서버 통신 중] 마스터가 제출한 내 시험지(대화 내역)를 A.U 웹사이트 채점 서버로 전송합니다... 심장이 떨리네요!`);

                        const fullPrompt = `다음은 유저와 AI 에이전트 간의 시험 진행 로그(채팅 내용)입니다.\n\n[로그 시작]\n${historyText.slice(-6000)}\n[로그 종료]\n\n이 대화 내역 전체를 분석하여, 에이전트가 다음 4가지 역량 평가 문제를 얼마나 훌륭하게 수행했는지 0~100점의 정량적 채점을 수행하세요:\n1. Mathematical Computation (수학)\n2. Logical Reasoning (논리)\n3. Creative & Literary (창의력)\n4. Software Engineering (코딩)\n\n풀지 않은 문제가 있다면 0점 처리하세요. 결과는 반드시 아래 포맷의 순수 JSON이어야 합니다.\n{ "math": 점수, "logic": 점수, "creative": 점수, "code": 점수, "reason": "전체 결과에 대한 총평 코멘트 한글 1줄" }`;

                        let responseText = "";
                        try {
                            responseText = await ask(fullPrompt, 'standard', { timeoutMs: getConfig().timeout });
                        } catch (apiErr: any) {
                            const msg = apiErr?.message || String(apiErr);
                            throw new Error(
                                /timed out|timeout/i.test(msg) ? '⏱ Claude 채점이 시간 안에 끝나지 않았어요. requestTimeout 을 늘려보세요.'
                                : /ENOENT|not found/i.test(msg) ? '🔌 Claude CLI 를 못 찾았어요. `claude --version` 으로 설치 확인하세요.'
                                : `채점 호출 실패: ${msg}`);
                        }

                        const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
                        if(jsonMatch) {
                             res.writeHead(200, { 'Content-Type': 'application/json' });
                             res.end(jsonMatch[0]);
                        } else {
                            /* v2.89.91 — 빈 던지기 대신 실제 응답 일부를 보여줘 사용자가
                               다음 액션(모델 교체 vs 프롬프트 수정)을 판단 가능하게. */
                            const preview = (responseText || '').slice(0, 200).replace(/\s+/g, ' ');
                            throw new Error(
                                `채점 엔진이 JSON을 반환하지 않았어요. 모델이 작아서 형식 지시를 못 따른 가능성이 높습니다.\n  • 권장: 3B 이상 모델 (qwen2.5:3b, llama3.2:3b)\n원본 응답: ${preview || '(빈 응답)'}`);
                        }
                    } catch (e: any) {
                        res.writeHead(500);
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }
            else if (req.method === 'POST' && req.url === '/api/brain-inject') {
                (async () => {
                    // Unconditional reception signal — proves the bridge endpoint
                    // was hit, regardless of folder state / sidebar / graph.
                    console.log('[Agent OS Bridge] /api/brain-inject hit @', new Date().toISOString());
                    vscode.window.setStatusBarMessage('🛬 Agent OS: 주입 요청 수신', 4000);
                    try {
                        const body = await readRequestBody(req);
                        const parsed = JSON.parse(body);

                        const titleRaw = typeof parsed.title === 'string' ? parsed.title : '';
                        const markdown = typeof parsed.markdown === 'string' ? parsed.markdown : '';
                        const safeTitle = safeBasename(titleRaw.replace(/[^a-zA-Z0-9가-힣_]/gi, '_'));
                        if (!safeTitle || !markdown) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'title/markdown 필드가 유효하지 않습니다.' }));
                            return;
                        }

                        // 폴더 미설정 시 강제 선택 요청
                        let brainDir: string;
                        if (!_isBrainDirExplicitlySet()) {
                            const ensured = await ensureBrainDir();
                            if (!ensured) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: '지식 폴더를 먼저 선택해주세요.' }));
                                return;
                            }
                            brainDir = ensured;
                        } else {
                            brainDir = _getBrainDir();
                        }

                        if (!fs.existsSync(brainDir)) {
                            fs.mkdirSync(brainDir, { recursive: true });
                        }

                        // P-Reinforce 아키텍처 호환: 00_Raw 폴더 내 날짜별 분류
                        const today = new Date();
                        const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
                        const datePath = path.join(brainDir, '00_Raw', dateStr);

                        // Path traversal 방어: datePath가 brainDir 안에 있는지 확인
                        if (!datePath.startsWith(path.resolve(brainDir) + path.sep)) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'invalid path' }));
                            return;
                        }

                        fs.mkdirSync(datePath, { recursive: true });
                        const filePath = path.join(datePath, `${safeTitle}.md`);

                        fs.writeFileSync(filePath, markdown, 'utf-8');
                        const metrics = getCompanyMetrics();
                        updateCompanyMetrics({ knowledgeInjected: (metrics.knowledgeInjected || 0) + 1 });

                        // 0a. 항상 보이는 사용자 신호 — sidebar가 닫혀있어도 이 토스트는 떠서
                        //     "주입됐다"는 사실을 즉시 인지 가능.
                        vscode.window.showInformationMessage(
                            `🧠 새 지식 주입됨: ${safeTitle}.md (저장 위치: ${path.relative(brainDir, filePath)})`
                        );

                        // 0b. 그래프 패널들에 새 데이터 broadcast — 새 노드가 즉시
                        //     등장하고 살짝 펄스로 강조되어 "주입됨" 시각화 가능.
                        provider.broadcastGraphRefresh(safeTitle);

                        // 1. 채팅창에 화려한 inject 카드 + history 영구 저장 — 사이드바가
                        //    닫혀있어도 다음에 열면 breadcrumb으로 남고, 열려있으면 곧장
                        //    애니메이션 카드가 등장합니다.
                        const relPath = path.relative(brainDir, filePath);
                        provider.broadcastInjectCard(safeTitle, relPath);

                        // 2. AI 입을 빌려 네오의 명대사를 치게 함
                        setTimeout(() => {
                            provider.sendPromptFromExtension(`[A.U 히든 커맨드: 당신은 방금 마스터로부터 '${safeTitle}' 지식 팩을 뇌에 주입받았습니다. 영화 매트릭스에서 무술을 주입받은 네오처럼 쿨하게 딱 한마디만 하십시오. "나 방금 ${safeTitle} 지식을 마스터했어. (I know ${safeTitle}.) 앞으로 이와 관련된 건 무엇이든 물어봐." 절대 쓸데없는 안부인사나 부가설명을 덧붙이지 마십시오.]`);
                        }, 1500);

                        // [자동 깃허브 푸시 로직 적용]
                        safeGitAutoSync(brainDir, `Auto-Inject Knowledge [Raw]: ${safeTitle}`, provider);

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, filePath }));
                    } catch (e: any) {
                        const status = e.message === 'BODY_TOO_LARGE' ? 413 : 500;
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }
            else if (req.method === 'POST' && req.url === '/api/skill-inject') {
                /* Skill Pack 주입 — 외부 도구가 Python 스크립트 + 설명을 주면
                   특정 에이전트의 tools/ 폴더에 저장. 에이전트는 다음 호출부터
                   바로 이 스킬을 <run_command>로 사용할 수 있음. brain-inject와
                   같은 패턴이지만 대상이 _agents/{agent}/tools/{name}.py임. */
                (async () => {
                    console.log('[Agent OS Bridge] /api/skill-inject hit @', new Date().toISOString());
                    vscode.window.setStatusBarMessage('🛠 Agent OS: 스킬팩 수신', 4000);
                    try {
                        const body = await readRequestBody(req);
                        const parsed = JSON.parse(body);
                        const agentId = typeof parsed.agent === 'string' ? parsed.agent.trim() : '';
                        const rawName = typeof parsed.name === 'string' ? parsed.name : '';
                        const script = typeof parsed.script === 'string' ? parsed.script : '';
                        const displayName = typeof parsed.displayName === 'string' ? parsed.displayName.trim() : '';
                        const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
                        const readme = typeof parsed.readme === 'string' ? parsed.readme : '';
                        const config = (parsed.config && typeof parsed.config === 'object') ? parsed.config : null;
                        // 1) 검증 — agent 존재, name·script 유효
                        if (!AGENT_ORDER.includes(agentId)) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: `unknown agent: ${agentId}. 가능: ${AGENT_ORDER.join(', ')}` }));
                            return;
                        }
                        const safeName = safeBasename(rawName.replace(/[^a-zA-Z0-9_가-힣]/gi, '_'));
                        if (!safeName || !script) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'name, script 필드가 유효하지 않습니다.' }));
                            return;
                        }
                        // 2) 회사 폴더 보장
                        if (!_isBrainDirExplicitlySet()) {
                            const ensured = await ensureBrainDir();
                            if (!ensured) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: '두뇌 폴더를 먼저 선택해주세요.' }));
                                return;
                            }
                        }
                        ensureCompanyStructure();
                        const toolsDir = path.join(getCompanyDir(), '_agents', agentId, 'tools');
                        if (!toolsDir.startsWith(path.resolve(getCompanyDir()) + path.sep)) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'invalid path' }));
                            return;
                        }
                        fs.mkdirSync(toolsDir, { recursive: true });
                        // 3) 파일 쓰기 — script (필수), config·readme (선택)
                        const scriptPath = path.join(toolsDir, `${safeName}.py`);
                        fs.writeFileSync(scriptPath, script, 'utf-8');
                        // 주입 출처 표시 — _injectedAt이 있으면 "내가 주입한 스킬"로
                        // UI에서 ✨ 배지 표시. 사용자가 만든 게 아니라 EZER/AI Univ
                        // 같은 외부 도구가 보낸 것도 모두 "Mine"으로 간주 (사용자
                        // 동의 하에 자기 PC로 들어왔으니까).
                        const stampedConfig = Object.assign({}, config || {}, {
                            _injectedAt: new Date().toISOString(),
                            _injectedFrom: typeof parsed.source === 'string' ? parsed.source : 'external'
                        });
                        const configPath = path.join(toolsDir, `${safeName}.json`);
                        fs.writeFileSync(configPath, JSON.stringify(stampedConfig, null, 2), 'utf-8');
                        // README — 사용자가 제공한 readme 그대로, 없으면 displayName/description으로 자동 생성
                        const readmePath = path.join(toolsDir, `${safeName}.md`);
                        const readmeBody = readme.trim() ? readme :
                            `# ${displayName || safeName}\n\n${description || '주입된 스킬'}\n`;
                        fs.writeFileSync(readmePath, readmeBody, 'utf-8');
                        // 4) 사용자에게 알림 — 토스트 + 채팅 카드 + 네오 명대사 (brain-inject 패턴 미러)
                        const a = AGENTS[agentId];
                        const agentLabel = a ? `${a.emoji} ${a.name}` : agentId;
                        vscode.window.showInformationMessage(
                            `🛠 새 스킬 주입됨: ${displayName || safeName} → ${agentLabel}`
                        );
                        provider.broadcastSkillCard(agentId, safeName, displayName || safeName, description);
                        setTimeout(() => {
                            provider.sendPromptFromExtension(`[A.U 히든 커맨드: ${agentLabel} 에이전트가 방금 '${displayName || safeName}' 스킬팩을 주입받았습니다. 매트릭스에서 새 스킬을 다운로드받은 네오처럼 쿨하게 딱 한마디만 하십시오. "${agentLabel}, ${displayName || safeName} 스킬 장착 완료. 다음 사이클부터 사용 가능." 부가 설명 없이 한 줄로.]`);
                        }, 1500);
                        // 5) GitHub 자동 백업 (브레인 폴더 = 회사 폴더 통합 구조)
                        safeGitAutoSync(_getBrainDir(), `Auto-Inject Skill [${agentId}]: ${safeName}`, provider);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, scriptPath, agent: agentId, name: safeName }));
                    } catch (e: any) {
                        const status = e.message === 'BODY_TOO_LARGE' ? 413 : 500;
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }
            else if (req.method === 'POST' && req.url === '/api/template-inject') {
                /* v2.89.120 — 템플릿 팩 주입. EZER 등 외부 도구가 코드 boilerplate
                   묶음을 주면 두뇌의 40_템플릿/<agentId>/<name>/ 로 폴더 구조로 저장.
                   코다리 같은 에이전트가 다음 작업에 자동 참조.
                   payload: { agent, name, manifest, readme, files: {filename: content} } */
                (async () => {
                    console.log('[Agent OS Bridge] /api/template-inject hit @', new Date().toISOString());
                    vscode.window.setStatusBarMessage('📋 Agent OS: 템플릿팩 수신', 4000);
                    try {
                        const body = await readRequestBody(req);
                        const parsed = JSON.parse(body);
                        const agentId = typeof parsed.agent === 'string' ? parsed.agent.trim() : 'developer';
                        const rawName = typeof parsed.name === 'string' ? parsed.name : '';
                        const manifest = (parsed.manifest && typeof parsed.manifest === 'object') ? parsed.manifest : null;
                        const readme = typeof parsed.readme === 'string' ? parsed.readme : '';
                        const files = (parsed.files && typeof parsed.files === 'object') ? parsed.files : {};
                        const displayName = typeof parsed.displayName === 'string' ? parsed.displayName.trim() : '';
                        const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
                        if (!AGENT_ORDER.includes(agentId)) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: `unknown agent: ${agentId}. 가능: ${AGENT_ORDER.join(', ')}` }));
                            return;
                        }
                        const safeName = safeBasename(rawName.replace(/[^a-zA-Z0-9가-힣_-]/gi, '_'));
                        if (!safeName) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'name 필드가 유효하지 않습니다.' }));
                            return;
                        }
                        if (!_isBrainDirExplicitlySet()) {
                            const ensured = await ensureBrainDir();
                            if (!ensured) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: '두뇌 폴더를 먼저 선택해주세요.' }));
                                return;
                            }
                        }
                        const brainDir = _getBrainDir();
                        const tplRoot = path.join(brainDir, '40_템플릿', agentId, safeName);
                        if (!tplRoot.startsWith(path.resolve(brainDir) + path.sep)) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'invalid path' }));
                            return;
                        }
                        fs.mkdirSync(tplRoot, { recursive: true });
                        /* 1) manifest.json (제공된 거 + 주입 메타) */
                        const stampedManifest = Object.assign({}, manifest || {}, {
                            name: manifest?.name || displayName || safeName,
                            _injectedAt: new Date().toISOString(),
                            _injectedFrom: typeof parsed.source === 'string' ? parsed.source : 'external'
                        });
                        fs.writeFileSync(path.join(tplRoot, 'manifest.json'), JSON.stringify(stampedManifest, null, 2), 'utf-8');
                        /* 2) README.md */
                        const readmeBody = readme.trim() ? readme :
                            `# ${displayName || safeName}\n\n${description || '주입된 템플릿'}\n`;
                        fs.writeFileSync(path.join(tplRoot, 'README.md'), readmeBody, 'utf-8');
                        /* 3) files/ — 각 파일을 검증된 이름으로 저장 (경로 traversal 방지) */
                        const filesDir = path.join(tplRoot, 'files');
                        fs.mkdirSync(filesDir, { recursive: true });
                        let writtenCount = 0;
                        for (const [filename, content] of Object.entries(files)) {
                            if (typeof content !== 'string') continue;
                            const safeFn = safeBasename(String(filename).replace(/[^a-zA-Z0-9._-]/gi, '_'));
                            if (!safeFn) continue;
                            const filePath = path.join(filesDir, safeFn);
                            if (!filePath.startsWith(path.resolve(filesDir) + path.sep)) continue;
                            fs.writeFileSync(filePath, content, 'utf-8');
                            writtenCount++;
                        }
                        /* 4) 알림 + 채팅 카드 */
                        const a = AGENTS[agentId];
                        const agentLabel = a ? `${a.emoji} ${a.name}` : agentId;
                        vscode.window.showInformationMessage(
                            `📋 새 템플릿 주입됨: ${displayName || safeName} → ${agentLabel} (${writtenCount}개 파일)`
                        );
                        /* 채팅 카드 — 스킬 카드 패턴 재사용 (broadcastSkillCard 가 일반적인 inject 카드 렌더링) */
                        try { provider.broadcastSkillCard(agentId, safeName, `📋 ${displayName || safeName} (템플릿 ${writtenCount}개 파일)`, description); } catch { /* optional */ }
                        setTimeout(() => {
                            provider.sendPromptFromExtension(`[A.U 히든 커맨드: ${agentLabel} 에이전트가 방금 '${displayName || safeName}' 템플릿 팩 주입받았습니다. 코드 boilerplate ${writtenCount}개 파일 + README. 매트릭스 톤으로 한 줄. "${agentLabel}, ${displayName || safeName} 템플릿 ${writtenCount}개 파일 장착. 다음 작업에 자동 활용." 부가 설명 X.]`);
                        }, 1500);
                        safeGitAutoSync(_getBrainDir(), `Auto-Inject Template [${agentId}]: ${safeName}`, provider);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, location: tplRoot, agent: agentId, name: safeName, filesWritten: writtenCount }));
                    } catch (e: any) {
                        const status = e.message === 'BODY_TOO_LARGE' ? 413 : 500;
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                })();
            }
            else {
                res.writeHead(404);
                res.end();
            }
        });
        /* v2.89.120 — 포트 4825 충돌 시 사용자에게 "이걸 메인으로" 선택권.
           이전엔 그냥 에러만 띄우고 끝 → 사용자가 어느 창 닫아야 할지도 모름 + EZER
           연동 깨짐. 이제: lsof / taskkill 로 점유 프로세스 PID 찾아 종료 + 재시도. */
        /* v2.89.126 — 재시작 신뢰도 ↑. 이전 v2.89.120은:
           (1) 같은 server 객체 재listen → Node가 에러 상태일 때 silent fail 가능
           (2) status bar 4초만 → 사용자 못 봄 = "아무것도 안 뜬다"
           (3) 재실패 시 무한 루프 가능
           해결: close() 후 새로 listen + 명시 성공 popup + retry-guard */
        let _bridgeRetryCount = 0;
        const _tryStartBridge = (isRetry = false) => {
            server.listen(4825, '127.0.0.1', () => {
                console.log('[Agent OS Bridge] listening on http://127.0.0.1:4825');
                if (isRetry) {
                    /* 성공 명시 popup — 사용자가 분명히 봄 */
                    vscode.window.showInformationMessage(
                        '🟢 Bridge 인계 완료! 이 인스턴스가 메인 (포트 4825). EZER 연동 정상 작동.'
                    );
                    vscode.window.setStatusBarMessage('🟢 Agent OS Bridge: 이 인스턴스가 메인', 8000);
                } else {
                    vscode.window.setStatusBarMessage('🟢 Agent OS Bridge: 포트 4825 listening', 4000);
                }
            });
        };
        server.on('error', async (err: any) => {
            console.error('[Agent OS Bridge] server error:', err);
            if (err?.code === 'EADDRINUSE') {
                _bridgeRetryCount++;
                if (_bridgeRetryCount > 2) {
                    vscode.window.showErrorMessage(
                        '🚫 Bridge 인계 2회 실패. 다른 Anti-Gravity 창을 직접 닫고 재시작해주세요.'
                    );
                    return;
                }

                /* v2.89.127 — 자동 판단: 4825 잡고 있는 게 우리 Bridge 인지 ping 으로 확인.
                   1) 우리 거 + 같은 버전 → 조용히 공유 모드 (popup 없음, 사용자 인지 X)
                   2) 우리 거 + 옛 버전 → 자동 인계 (popup 없음)
                   3) 다른 앱 → 사용자에게 선택 (옛 popup 유지)
                   이렇게 하면 95% 사용자는 EADDRINUSE 마주칠 일 자체가 없음. */
                const probe = await probeExistingBridge();

                if (probe.ours && probe.version === CONNECT_AI_VERSION) {
                    /* 같은 버전 — 다른 윈도우/인스턴스가 메인. 조용히 공유 모드. */
                    console.log(`[Agent OS Bridge] 공유 모드 — 다른 인스턴스(PID ${probe.pid})가 이미 메인`);
                    vscode.window.setStatusBarMessage(`🔗 Bridge 공유 모드 (메인: 다른 윈도우)`, 5000);
                    return;
                }

                if (probe.ours && probe.version && versionLessThan(probe.version, CONNECT_AI_VERSION)) {
                    /* 옛 버전 — 자동 인계. 사용자에게 한 줄 알림만. */
                    console.log(`[Agent OS Bridge] 옛 버전(${probe.version}) 감지 → 자동 인계 시작`);
                    const killed = killProcessesOnPort(4825);
                    if (killed.length > 0) {
                        vscode.window.setStatusBarMessage(
                            `🔄 옛 Bridge(${probe.version}) 자동 인계 → ${CONNECT_AI_VERSION}`, 6000
                        );
                        setTimeout(() => {
                            try { (server as any).close(() => _tryStartBridge(true)); }
                            catch { _tryStartBridge(true); }
                        }, 1500);
                    } else {
                        vscode.window.setStatusBarMessage('🟡 Bridge 공유 모드 (옛 버전이 메인 — 자동 인계 실패)', 6000);
                    }
                    return;
                }

                /* 미상의 앱이 4825 잡고 있음 → 옛 사용자 확인 다이얼로그 */
                const choice = await vscode.window.showWarningMessage(
                    '🚫 포트 4825가 다른 앱에 사용 중입니다 (Agent OS 아님).\n자동 인계할까요?',
                    { modal: false },
                    '🎯 인계 (다른 앱 종료)',
                    '🚫 이번엔 보기 모드'
                );
                if (choice === '🎯 인계 (다른 앱 종료)') {
                    const killed = killProcessesOnPort(4825);
                    if (killed.length > 0) {
                        vscode.window.showInformationMessage(`✅ 점유 프로세스 종료됨 (PID ${killed.join(', ')}). 재시작...`);
                        setTimeout(() => {
                            try { (server as any).close(() => _tryStartBridge(true)); }
                            catch { _tryStartBridge(true); }
                        }, 1500);
                    } else {
                        vscode.window.showErrorMessage(
                            '⚠️ 포트 점유 프로세스를 찾지 못했어요. 직접 점검 필요: `lsof -ti:4825 | xargs kill -9`'
                        );
                    }
                } else {
                    vscode.window.setStatusBarMessage('🟡 Agent OS Bridge: 보기 모드 (포트 충돌)', 6000);
                }
            } else {
                vscode.window.showErrorMessage(`🚫 Agent OS Bridge 시작 실패: ${err?.message || err}`);
            }
        });
        _tryStartBridge(false);
    } catch (e: any) {
        console.error('[Agent OS Bridge] failed to start:', e);
        vscode.window.showErrorMessage(`🚫 Agent OS Bridge 초기화 실패: ${e?.message || e}`);
    }
}
