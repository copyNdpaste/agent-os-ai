/**
 * Telegram markdown sanitizer.
 *
 * extension.ts 에서 분리됨 (god-file Telegram 모듈화). pure function — no I/O.
 *
 * v2.89.157 — Telegram legacy Markdown 은 ## / ### 헤더·- 리스트·표를 지원 안 함.
 * 원본 마크다운을 Telegram 이 렌더 가능한 *bold* + 깔끔한 indent 로 변환.
 */

export function markdownToTelegram(src: string): string {
    let s = src || '';
    s = s.replace(/^#{4,6}\s+(.+)$/gm, '*$1*');
    s = s.replace(/^###\s+(.+)$/gm, '*$1*');
    s = s.replace(/^##\s+(.+)$/gm, '\n*━━ $1 ━━*');
    s = s.replace(/^#\s+(.+)$/gm, '\n*『$1』*');
    s = s.replace(/^\s*\|.*\|\s*$/gm, (line: string) => {
        const cells = line.split('|').map(c => c.trim()).filter(c => c.length > 0);
        if (cells.every(c => /^[-:\s]+$/.test(c))) return '';
        return '• ' + cells.join(' · ');
    });
    s = s.replace(/\n\n+/g, '\n\n');
    return s.trim();
}
