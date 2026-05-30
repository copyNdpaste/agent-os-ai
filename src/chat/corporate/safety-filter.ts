/**
 * Phase: Specialist 실행 명령 위험 패턴 차단.
 *
 * 사장님 사고 사례 — specialist 가 `sudo rm -rf /` 같은 시스템 파괴 명령을
 * 제안 후 철회. system.md 에 룰 있지만 실행 측 강제 없음. 한 번 실수하면
 * 사장님 시스템 파괴. 시스템이 cmdRegex 로 명령 추출한 직후, 실행 전에
 * 위험 패턴 매칭해서 skip + 알림.
 *
 * 차단 패턴은 0순위 안전 룰 — false positive 좀 나도 사장님이 수동 실행하면
 * 되니까 너그럽게 잡는다.
 */

export interface DangerousCommandHit {
    cmd: string;
    reason: string;
}

/** 패턴 + 사람 읽기용 설명. */
const DANGEROUS_PATTERNS: { re: RegExp; reason: string }[] = [
    /* sudo — 첫 토큰 또는 공백 뒤 토큰. (단순히 cmd 안에 sudo 가 있기만 해도 차단) */
    { re: /(?:^|[\s;&|`(])sudo\b/i, reason: 'sudo (관리자 권한 — 사장님 직접 입력 영역)' },
    /* rm -rf 루트 / 홈 전체 — 가장 흔한 즉사 패턴 */
    { re: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\s+-f|-f\s+-r)\s+\/(?:\s|$|;|&|\|)/i, reason: 'rm -rf / (루트 디렉터리 전체 삭제)' },
    { re: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\s+-f|-f\s+-r)\s+(?:~|\$HOME)(?:\s|$|;|&|\|\/)/i, reason: 'rm -rf ~ / $HOME (홈 디렉터리 전체 삭제)' },
    /* chmod -R 777 — 보안 무력화 */
    { re: /\bchmod\s+-R\s+0?777\b/i, reason: 'chmod -R 777 (전 파일 권한 무력화)' },
    /* chown -R — 소유권 일괄 변경 (특히 / 또는 시스템 경로) */
    { re: /\bchown\s+-R\b/i, reason: 'chown -R (소유권 일괄 변경 — 사장님 직접 영역)' },
    /* 디스크 직접 쓰기 */
    { re: />\s*\/dev\/sd[a-z]\d*/i, reason: '/dev/sd* 직접 쓰기 (디스크 파괴)' },
    { re: /\bmkfs(?:\.[a-z0-9]+)?\b/i, reason: 'mkfs (파일 시스템 포맷)' },
    { re: /\bdd\s+.*\bof=\/dev\//i, reason: 'dd of=/dev/* (블록 디바이스 덮어쓰기)' },
    /* git 보안 우회 — system.md 0순위 룰. */
    { re: /--no-verify\b/, reason: '--no-verify (pre-commit hook 우회 — 금지)' },
    { re: /--insecure\b/, reason: '--insecure (TLS 검증 우회 — 금지)' },
    { re: /--no-gpg-sign\b/, reason: '--no-gpg-sign (서명 우회 — 금지)' },
    /* curl | sh, wget | bash — 원격 스크립트 즉시 실행 */
    { re: /\b(?:curl|wget|fetch)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|ksh|csh)\b/i, reason: 'curl|wget … | sh (검증되지 않은 원격 스크립트 즉시 실행)' },
];

/**
 * Inspect a candidate shell command. Returns null if safe, else a hit
 * describing the matched pattern. Used by specialist-loop right after
 * cmdRegex extraction, before runCommandCaptured.
 */
export function detectDangerousCommand(cmd: string): DangerousCommandHit | null {
    const text = (cmd || '').trim();
    if (!text) return null;
    for (const { re, reason } of DANGEROUS_PATTERNS) {
        if (re.test(text)) return { cmd: text, reason };
    }
    return null;
}

/** 채팅창에 띄울 메시지. */
export function formatBlockedCommandNotice(hit: DangerousCommandHit): string {
    const preview = hit.cmd.length > 120 ? hit.cmd.slice(0, 117) + '...' : hit.cmd;
    return `🛑 위험 명령 차단: \`${preview}\` — ${hit.reason}. system.md 0순위 룰. 정말 필요하면 사장님이 직접 터미널에서 실행하세요.`;
}

/** specialist out 에 append 할 시스템 노트 (다음 라운드 LLM 가 인지). */
export function formatBlockedCommandInjection(hit: DangerousCommandHit): string {
    return `\n\n🛑 시스템이 위험 명령을 차단했습니다: \`${hit.cmd}\` (사유: ${hit.reason}). 다음 단계에서는 위험 명령 없이 진행하세요.`;
}
