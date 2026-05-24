/* Developer / diagnostic commands —
   - agentOs.diagnoseConnection: Claude CLI + Python env health report.
   - agentOs.dailyBriefing.fireNow: trigger daily briefing immediately.
   - agentOs.skill.saveLast: promote last specialist output to a reusable skill.
   - agentOs.developer.scaffoldProject: create a new project folder under
     _company/projects/ using a chosen template. */

import * as vscode from 'vscode';
import { ask, resolveClaudeBin, pingClaude, resolveCodexBin, pingCodex } from '../llm';
import { setupStarterPack, listCodexMcpServers } from '../codex/mcp-config';
import {
    pythonCmd as _pythonCmd,
    invalidatePythonCmdCache as _invalidatePythonCmdCache,
    pythonMissingHint as _pythonMissingHint,
} from '../infra/python';
import {
    _runDailyBriefingOnce,
} from '../loops';
import {
    _getLastSpecialistOutput, saveAgentSkill, appendAgentMemory,
} from '../brain/agent-glue';
import { AGENTS, SPECIALIST_IDS } from '../agents';
import { appendConversationLog } from '../extension';
import { scaffoldDeveloperProject } from '../scaffolders';
import type { CommandProviders } from './index';

export function registerDevCommands(
    context: vscode.ExtensionContext,
    _providers: CommandProviders
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('agentOs.diagnoseConnection', async () => {
            const out: string[] = [];
            const ok = (s: string) => out.push(`✅ ${s}`);
            const warn = (s: string) => out.push(`⚠️ ${s}`);
            const err = (s: string) => out.push(`❌ ${s}`);
            const info = (s: string) => out.push(`ℹ️ ${s}`);

            out.push('## 🤖 Claude CLI');
            const bin = resolveClaudeBin();
            info(`Claude binary: \`${bin || '(미설정 — PATH의 claude 사용 시도)'}\``);

            let versionOk = false;
            try {
                const version = await pingClaude();
                ok(`\`claude --version\` 응답: ${version}`);
                versionOk = true;
            } catch (e: any) {
                err(`Claude CLI 호출 실패: ${e?.message || e}`);
                info('설치 안 됐으면: 공식 가이드 https://docs.claude.com/en/docs/claude-code/setup 따라 설치 후 `claude login`.');
                info('이미 있으면: `which claude` 결과를 settings.json의 `agentOs.claudeBinPath` 에 넣어보세요.');
            }

            if (versionOk) {
                try {
                    const reply = await ask('Say "pong" and nothing else.', 'standard', { timeoutMs: 20_000 });
                    if (/pong/i.test(reply)) {
                        ok(`Sonnet 응답 OK — "${reply.trim().slice(0, 40)}"`);
                    } else {
                        warn(`Sonnet 응답이 예상과 다름: "${reply.trim().slice(0, 80)}"`);
                    }
                } catch (e: any) {
                    err(`Claude 응답 실패: ${e?.message || e}`);
                    info('Claude Max 구독 상태나 `claude login` 인증을 확인하세요.');
                }
            }

            /* v2.89.152 — Python 환경 진단. paypal_revenue·my_videos_check 같은 .py 도구
               실행이 exit 1 로 떨어질 때 어디서 막혔는지 사용자가 직접 진단. */
            out.push('');
            out.push('## 🐍 Python 환경');
            try {
                const _invalidate = require('child_process');
                _invalidatePythonCmdCache();
                const pyCmd = _pythonCmd();
                info(`자동 감지 결과: \`${pyCmd}\``);
                try {
                    const parts = pyCmd.split(' ');
                    const r = _invalidate.spawnSync(parts[0], parts.slice(1).concat(['--version']), { encoding: 'utf-8', timeout: 4000 });
                    const ver = ((r.stdout || '') + (r.stderr || '')).trim();
                    if (r.status === 0 && /python\s+3/i.test(ver)) {
                        ok(`Python 3 확인: ${ver}`);
                    } else if (/python\s+3\.\d/i.test(ver)) {
                        ok(`Python 3 (status ${r.status}): ${ver}`);
                    } else {
                        err(`Python 3 미감지. status=${r.status}, output=${ver.slice(0, 100)}`);
                        info(_pythonMissingHint());
                    }
                } catch (pe: any) {
                    err(`Python 호출 실패: ${pe?.message || pe}`);
                    info(_pythonMissingHint());
                }
                /* 사용자 override 표시 */
                try {
                    const cfgPy = (vscode.workspace.getConfiguration('agentOs').get<string>('pythonPath') || '').trim();
                    if (cfgPy) info(`사용자 설정 (\`agentOs.pythonPath\`): \`${cfgPy}\``);
                    else info(`사용자 설정 없음 (자동 감지 사용). 직접 지정하려면 명령 팔레트 → "설정 열기" → \`agentOs.pythonPath\``);
                } catch { /* ignore */ }
                /* 평행 진단 — 다른 후보 명령들 작동 여부 */
                const altCmds = process.platform === 'win32'
                    ? ['py', 'py -3', 'python', 'python3']
                    : ['python3', 'python', '/usr/bin/python3', '/opt/homebrew/bin/python3'];
                const altResults: string[] = [];
                for (const c of altCmds) {
                    try {
                        const parts = c.split(' ');
                        const r = _invalidate.spawnSync(parts[0], parts.slice(1).concat(['--version']), { encoding: 'utf-8', timeout: 2500 });
                        const ver = ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 50);
                        if (/python\s+3\.\d/i.test(ver)) altResults.push(`  ✅ \`${c}\` → ${ver}`);
                        else if (r.status === 0) altResults.push(`  ⚠️ \`${c}\` → ${ver || '(no version output)'}`);
                        else altResults.push(`  ❌ \`${c}\` → 실패 (status ${r.status})`);
                    } catch (e: any) {
                        altResults.push(`  ❌ \`${c}\` → 호출 실패: ${(e?.message || '').slice(0, 50)}`);
                    }
                }
                info('후보 명령 평행 테스트:');
                altResults.forEach(r => out.push(r));
            } catch (pyErr: any) {
                err(`Python 진단 자체 실패: ${pyErr?.message || pyErr}`);
            }

            /* 결과 패널 표시 */
            const doc = await vscode.workspace.openTextDocument({
                language: 'markdown',
                content: `# 🔍 Agent OS — Claude CLI 연결 진단\n\n_${new Date().toLocaleString('ko-KR')}_\n\n${out.join('\n')}\n\n---\n\n## 자주 막히는 곳\n\n### Claude CLI가 처음이면\n1. 공식 설치 가이드: https://docs.claude.com/en/docs/claude-code/setup\n2. 설치 후 터미널에서 \`claude login\` 으로 Claude Max 계정 인증\n3. \`claude --version\` 으로 동작 확인\n4. Agent OS 다시 열고 채팅 시도\n\n### \`claude\` 명령을 못 찾는다면\n- \`which claude\` 결과를 settings.json 의 \`agentOs.claudeBinPath\` 에 절대경로로 박아두세요.\n- 예: \`/Users/hoony/.local/bin/claude\` 또는 \`~/bin/claude\`\n\n### 그래도 안 되면\n- VS Code/Anti-Gravity 재시작\n- 명령 팔레트 (Cmd+Shift+P) → \`Agent OS: 연결 진단\` 다시 실행\n- 위 결과 스크린샷과 함께 제보\n`,
            });
            await vscode.window.showTextDocument(doc, { preview: false });
        }),
        /* Codex MCP 글로벌 도우미 — 사장님 정책: 이미지·콘텐츠 생성은 codex 의
           ChatGPT 구독 인증 도구로만 (OpenAI API per-call 청구 금지). 이 명령은
           filesystem MCP 하나만 ~/.codex/config.toml 에 추가해서 codex 가
           워크스페이스 파일을 직접 다룰 수 있게 함. 모든 프로젝트에서 자동 적용. */
        vscode.commands.registerCommand('agentOs.codex.setupMcp', async () => {
            try {
                const codex = resolveCodexBin();
                vscode.window.showInformationMessage(`🟢 Codex (${codex || 'codex'}) — filesystem MCP 등록 중 (path 는 호출 시 자동 격리)…`);
                /* allowedPath 인자는 더 이상 사용 안 함 — codex-cli.ts 가 매 호출마다
                   현재 워크스페이스로 동적 override. setup 은 글로벌 등록 한 번만. */
                const r = await setupStarterPack();
                const lines: string[] = [];
                if (r.added.length > 0) lines.push(`✅ 추가: ${r.added.join(', ')}`);
                if (r.skipped.length > 0) lines.push(`⏭ 스킵: ${r.skipped.map(s => `${s.name} (${s.reason})`).join(', ')}`);
                if (lines.length === 0) lines.push('변경 사항 없음');
                vscode.window.showInformationMessage(`Codex MCP — ${lines.join(' · ')} · 워크스페이스간 자동 격리`);
            } catch (e: any) {
                vscode.window.showErrorMessage(`Codex MCP 설정 실패: ${e?.message || e}`);
            }
        }),
        /* 현재 등록된 codex MCP 서버 목록 확인 — 진단/디버깅용. */
        vscode.commands.registerCommand('agentOs.codex.listMcp', async () => {
            try {
                const list = await listCodexMcpServers();
                if (list.length === 0) {
                    vscode.window.showInformationMessage('등록된 Codex MCP 서버가 없어요. `Agent OS: Codex MCP 설정` 명령으로 starter pack 추가 가능.');
                    return;
                }
                const body = list.map(e => `- **${e.name}** \`${e.command}\` (${e.status})`).join('\n');
                const doc = await vscode.workspace.openTextDocument({
                    language: 'markdown',
                    content: `# 🟢 Codex MCP 서버 목록\n\n_${new Date().toLocaleString('ko-KR')}_\n\n${body}\n\n---\n_총 ${list.length}개. 추가: \`codex mcp add <name> -- <cmd>\` / 제거: \`codex mcp remove <name>\`_\n`,
                });
                await vscode.window.showTextDocument(doc, { preview: false });
            } catch (e: any) {
                vscode.window.showErrorMessage(`Codex MCP 목록 조회 실패: ${e?.message || e}`);
            }
        }),
        vscode.commands.registerCommand('agentOs.dailyBriefing.fireNow', async () => {
            try {
                await _runDailyBriefingOnce(true);
                vscode.window.showInformationMessage('🌅 데일리 브리핑이 텔레그램으로 발송됐어요. (토큰 미설정이면 무시됨)');
            } catch (e: any) {
                vscode.window.showErrorMessage(`브리핑 발사 실패: ${e?.message || e}`);
            }
        }),
        /* v2.89.115 — 직전 specialist 산출물을 재사용 가능한 패턴으로 승격.
           Hermes Agent의 self-improving skill 패턴을 1인 기업 컨셉에 맞게
           단순화 (자동 노이즈 X, 사용자가 명시적으로 트리거할 때만). */
        vscode.commands.registerCommand('agentOs.skill.saveLast', async () => {
            try {
                const last = _getLastSpecialistOutput();
                if (!last) {
                    vscode.window.showWarningMessage('직전 specialist 산출물을 찾지 못했어요. 작업 한 번 시킨 다음에 호출하세요.');
                    return;
                }
                const allIds = SPECIALIST_IDS.slice();
                const items = allIds.map(id => {
                    const a = AGENTS[id];
                    const isDefault = id === last.agentId;
                    return {
                        label: `${a.emoji} ${a.name}${isDefault ? '  (직전 발화)' : ''}`,
                        description: a.role,
                        id,
                    } as vscode.QuickPickItem & { id: string };
                });
                const pick = await vscode.window.showQuickPick(items, {
                    placeHolder: `어느 에이전트의 스킬로 저장할까요? (직전: ${AGENTS[last.agentId]?.name})`,
                });
                if (!pick) return;
                vscode.window.showInformationMessage(`💎 ${AGENTS[pick.id].name} — 패턴화 중…`);
                const result = await saveAgentSkill(pick.id, last.body, { titleHint: last.body.slice(0, 80) });
                if (!result.ok) {
                    vscode.window.showWarningMessage(`⚠️ ${result.reason}`);
                    try { appendConversationLog({ speaker: '시스템', emoji: '💎', section: '스킬 저장 시도', body: `${AGENTS[pick.id].name} → ${result.reason}` }); } catch { /* ignore */ }
                    return;
                }
                vscode.window.showInformationMessage(`✅ ${AGENTS[pick.id].name} 스킬 저장됨: ${result.title}`);
                try { appendConversationLog({ speaker: '시스템', emoji: '💎', section: '스킬 저장', body: `${AGENTS[pick.id].name} → ${result.title}` }); } catch { /* ignore */ }
                try { appendAgentMemory(pick.id, `[skill 승격] "${result.title}" — 다음 사이클부터 패턴 재사용`); } catch { /* ignore */ }
                /* 새로 만든 파일 바로 열어서 사용자가 검토·수정할 수 있게 */
                try { await vscode.window.showTextDocument(vscode.Uri.file(result.path)); } catch { /* ignore */ }
            } catch (e: any) {
                vscode.window.showErrorMessage(`스킬 저장 실패: ${e?.message || e}`);
            }
        }),
        vscode.commands.registerCommand('agentOs.developer.scaffoldProject', async () => {
            try {
                const name = await vscode.window.showInputBox({
                    placeHolder: '프로젝트 이름 (영문/숫자/하이픈)',
                    prompt: 'Developer 에이전트가 _company/projects/ 안에 만들 폴더 이름',
                    validateInput: (v) => /^[a-zA-Z0-9_-]{2,40}$/.test(v) ? null : '영문·숫자·-·_ 만, 2~40자',
                });
                if (!name) return;
                const tpl = await vscode.window.showQuickPick(
                    [
                        { label: 'vite-vanilla', detail: 'Vite + 순수 JS' },
                        { label: 'vite-react',   detail: 'Vite + React + TypeScript' },
                        { label: 'static',       detail: 'index.html 한 장 (Tailwind CDN)' },
                    ],
                    { placeHolder: '템플릿 선택' }
                );
                if (!tpl) return;
                const result = await scaffoldDeveloperProject(name, tpl.label as 'vite-vanilla' | 'vite-react' | 'static');
                if (result.ok) {
                    const open = await vscode.window.showInformationMessage(
                        `✅ \`${name}\` 생성 완료 — ${result.path}`,
                        '폴더 열기',
                        '닫기'
                    );
                    if (open === '폴더 열기') {
                        const uri = vscode.Uri.file(result.path);
                        vscode.commands.executeCommand('revealFileInOS', uri);
                    }
                } else {
                    vscode.window.showErrorMessage(`❌ ${result.error}`);
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`프로젝트 생성 실패: ${e?.message || e}`);
            }
        })
    );
}
