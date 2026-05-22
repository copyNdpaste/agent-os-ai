/**
 * 파일 시스템 glob/grep — node-glob 의존성 없이 fs 만 사용.
 *
 * extension.ts 에서 분리됨.
 */
import * as fs from 'fs';
import * as path from 'path';

const SKIP_DIRS = new Set([
    'node_modules', '.git', '.next', 'dist', 'out', 'build',
    '.cache', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
]);

/**
 * glob 매칭 (간단 버전). `*`, `**`, `?` 지원.
 * 결과 최대 maxResults개 (기본 200), depth 최대 12.
 */
export function globMatch(pattern: string, root: string, maxResults: number = 200): string[] {
    const re = globToRegex(pattern);
    const results: string[] = [];
    function walk(dir: string, depth: number) {
        if (results.length >= maxResults || depth > 12) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (results.length >= maxResults) return;
            if (e.name.startsWith('.git')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                walk(full, depth + 1);
            } else if (e.isFile()) {
                const rel = path.relative(root, full).split(path.sep).join('/');
                if (re.test(rel)) results.push(rel);
            }
        }
    }
    walk(root, 0);
    return results;
}

/** glob 패턴 → 정규식 변환. */
export function globToRegex(pattern: string): RegExp {
    let re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    re = re.replace(/\*\*\//g, '__GLOBSTAR_SLASH__');
    re = re.replace(/\*\*/g, '__GLOBSTAR__');
    re = re.replace(/\*/g, '[^/]*');
    re = re.replace(/\?/g, '[^/]');
    re = re.replace(/__GLOBSTAR_SLASH__/g, '(?:.*/)?');
    re = re.replace(/__GLOBSTAR__/g, '.*');
    return new RegExp('^' + re + '$', 'i');
}

/**
 * grep: 파일 내용에서 패턴 검색. case-insensitive.
 * 결과 최대 50파일·파일당 10매치·파일당 1MB 초과 스킵.
 */
export function grepFiles(pattern: string, root: string, fileGlob?: string): {
    file: string; matches: { line: number; text: string }[]
}[] {
    let regex: RegExp;
    try { regex = new RegExp(pattern, 'i'); }
    catch { return []; }
    const fileRe = fileGlob ? globToRegex(fileGlob) : null;
    const results: { file: string; matches: { line: number; text: string }[] }[] = [];
    const MAX_FILES = 50;
    const MAX_PER_FILE = 10;
    const MAX_FILE_BYTES = 1024 * 1024;
    function walk(dir: string, depth: number) {
        if (results.length >= MAX_FILES || depth > 12) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (results.length >= MAX_FILES) return;
            if (e.name.startsWith('.git')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name)) continue;
                walk(full, depth + 1);
            } else if (e.isFile()) {
                const rel = path.relative(root, full).split(path.sep).join('/');
                if (fileRe && !fileRe.test(rel)) continue;
                try {
                    const stat = fs.statSync(full);
                    if (stat.size > MAX_FILE_BYTES) continue;
                    const buf = fs.readFileSync(full);
                    if (buf.slice(0, 512).includes(0)) continue;
                    const lines = buf.toString('utf-8').split('\n');
                    const matches: { line: number; text: string }[] = [];
                    for (let i = 0; i < lines.length; i++) {
                        if (regex.test(lines[i])) {
                            matches.push({ line: i + 1, text: lines[i].slice(0, 200) });
                            if (matches.length >= MAX_PER_FILE) break;
                        }
                    }
                    if (matches.length > 0) results.push({ file: rel, matches });
                } catch { /* skip */ }
            }
        }
    }
    walk(root, 0);
    return results;
}
