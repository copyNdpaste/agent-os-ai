/**
 * 경로 보안 유틸 — traversal 방지, 시스템 보호 경로 차단, 파일명 sanitize.
 *
 * extension.ts 에서 분리됨. pure helpers — fs I/O 는 caller 가 담당.
 */
import * as os from 'os';
import * as path from 'path';

export const MAX_FILE_NAME_LEN = 200;

const SYSTEM_PATH_BLOCKLIST = [
    '/etc', '/System', '/usr/bin', '/usr/sbin', '/bin', '/sbin', '/var/db',
    '/private/etc', '/private/var/db',
];

/**
 * Resolve `relPath` against `root` and confirm the result stays within `root`.
 * Returns absolute path on success, null if traversal is detected.
 */
export function safeResolveInside(root: string, relPath: string): string | null {
    if (typeof relPath !== 'string' || relPath.length === 0) return null;
    const resolvedRoot = path.resolve(root);
    const abs = path.resolve(resolvedRoot, relPath);
    const rel = path.relative(resolvedRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return abs;
}

/**
 * 자유로운 경로 해석. "~/Documents/foo.md", "$HOME/x", 절대경로 모두 지원.
 * 시스템 보호 경로(/etc, /System, /usr/bin 등)만 차단.
 * 반환: { abs } 정상 / { abs, reason } 차단 / null 입력 무효
 */
export function resolveFlexiblePath(input: string, root: string): { abs: string; reason?: string } | null {
    if (typeof input !== 'string') return null;
    let s = input.trim();
    if (!s) return null;

    s = s.replace(/\$\{?(HOME|USER|USERNAME|TMPDIR|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH)\}?/g, (_m, k) => {
        if (k === 'HOME') return process.env.HOME || os.homedir();
        if (k === 'USER' || k === 'USERNAME') return process.env.USER || process.env.USERNAME || os.userInfo().username || _m;
        if (k === 'TMPDIR' || k === 'TEMP' || k === 'TMP') return process.env.TMPDIR || process.env.TEMP || process.env.TMP || os.tmpdir();
        const v = process.env[k]; return v || _m;
    });

    if (s === '~') s = os.homedir();
    else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2));

    let abs = path.isAbsolute(s) ? path.resolve(s) : path.resolve(root, s);
    abs = path.normalize(abs);

    for (const blocked of SYSTEM_PATH_BLOCKLIST) {
        if (abs === blocked || abs.startsWith(blocked + path.sep)) {
            return { abs, reason: `시스템 보호 경로(${blocked})에는 쓰지 않습니다. 사용자 홈/워크스페이스 안의 경로를 지정해주세요.` };
        }
    }

    if (process.platform === 'win32') {
        const upper = abs.toUpperCase();
        const winDirs = [
            (process.env.WINDIR || 'C:\\WINDOWS').toUpperCase(),
            (process.env.PROGRAMFILES || 'C:\\PROGRAM FILES').toUpperCase(),
            (process.env['PROGRAMFILES(X86)'] || 'C:\\PROGRAM FILES (X86)').toUpperCase(),
            (process.env.PROGRAMDATA || 'C:\\PROGRAMDATA').toUpperCase(),
            (process.env.SYSTEMROOT || 'C:\\WINDOWS').toUpperCase(),
        ];
        for (const w of winDirs) {
            if (upper === w || upper.startsWith(w + path.sep)) {
                return { abs, reason: `시스템 보호 경로(${w})에는 쓰지 않습니다. Documents·Desktop·다른 사용자 폴더로 지정해주세요.` };
            }
        }
    }
    return { abs };
}

/**
 * Sanitize a filename: remove path separators / traversal segments / control chars.
 * Returns a safe basename (never a path) or null if nothing usable remains.
 */
export function safeBasename(name: string): string | null {
    if (typeof name !== 'string') return null;
    const base = path.basename(name).replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').trim();
    if (!base || base === '.' || base === '..') return null;
    return base.slice(0, MAX_FILE_NAME_LEN);
}
