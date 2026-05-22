/**
 * createApproval — pending/ 디렉토리에 .md + .json 파일을 작성.
 *
 * extension.ts 의 _approvalNewId / createApproval 에서 분리됨.
 * Telegram/conversation-log/pulse 같은 통합 사이드 이펙트는 호출자 (extension.ts)
 * 에 남긴다 — 이 모듈은 순수 파일 IO 만 담당.
 *
 * 마크다운 포맷은 원본과 byte-for-byte 동일 — 옵션으로 agentLabel resolver 를
 * 주입하면 `${emoji} ${name}` 라인을 그대로 재현한다.
 */
import * as path from 'path';
import * as fs from 'fs';
import type { PendingApproval, AgentLabelResolver } from './types';
import { pendingDir } from './paths';

/**
 * `apr-<timestamp14>-<rand4>` 형식의 새 id 를 만든다.
 *
 * 원본 그대로 — date.toISOString() 의 구분자를 모두 제거한 뒤 앞 14자리 +
 * Math.random base36 4자리. 동시 호출 시 충돌 가능성은 매우 낮지만 cryptographic
 * 보장은 없다 (원본 디자인 유지).
 */
export function newApprovalId(): string {
    const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 6);
    return `apr-${stamp}-${rand}`;
}

export interface CreateApprovalOptions {
    /** AGENTS map 을 외부에서 주입 — 없으면 raw agentId 사용. */
    agentLabel?: AgentLabelResolver;
}

/**
 * 새 승인 요청을 작성한다.
 *
 * - id + createdAt 은 함수가 자동 부여.
 * - pending/{id}.md  — 사람이 VS Code 에서 열어 미리 볼 수 있는 마크다운
 * - pending/{id}.json — 실행기/리스트가 파싱하는 정규 데이터
 *
 * 반환 객체는 정규화된 PendingApproval (id + createdAt 포함).
 */
export function createApproval(
    companyDir: string,
    req: Omit<PendingApproval, 'id' | 'createdAt'>,
    opts: CreateApprovalOptions = {}
): PendingApproval {
    const dir = pendingDir(companyDir);
    fs.mkdirSync(dir, { recursive: true });
    const ap: PendingApproval = {
        id: newApprovalId(),
        createdAt: new Date().toISOString(),
        ...req,
    };
    /* Markdown front for human-readable preview (so opening the file in VS
       Code shows what's about to happen), JSON fence for the executor. */
    const labelRaw = opts.agentLabel ? opts.agentLabel(ap.agentId) : undefined;
    const ownerLine = labelRaw && labelRaw.length > 0 ? labelRaw : ap.agentId;
    const md = `# ⏳ 승인 대기 — ${ap.title}

- **에이전트:** ${ownerLine}
- **종류:** \`${ap.kind}\`
- **요청 시각:** ${ap.createdAt}
- **id:** \`${ap.id.slice(-9)}\`

## 요약

${ap.summary || '_(없음)_'}

## 사용자 결정

텔레그램에서 \`/approve ${ap.id.slice(-9)}\` 또는 \`/reject ${ap.id.slice(-9)}\` —
사이드바 "승인 대기" 패널에서도 가능합니다.

## payload (실행기에 전달)

\`\`\`json
${JSON.stringify(ap.payload, null, 2)}
\`\`\`
`;
    fs.writeFileSync(path.join(dir, `${ap.id}.md`), md);
    fs.writeFileSync(path.join(dir, `${ap.id}.json`), JSON.stringify(ap, null, 2));
    return ap;
}
