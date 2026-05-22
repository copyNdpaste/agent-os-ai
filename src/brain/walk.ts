/**
 * Brain markdown walker.
 *
 * extension.ts 에서 byte-for-byte 추출. brain corpus 를 BFS 로 순회하면서
 * .md / .txt 파일 절대경로 목록 반환. depth/file 캡으로 사고 방지.
 *
 * 또한 회사 영역(`_company/`)의 내부 임시 폴더 — agent self-output / cache 가
 * brain context 에 역주입되지 않도록 skip 하기 위한 `COMPANY_INTERNAL_DIRS`
 * 상수도 여기 둔다. 원래 extension.ts top-level 에 있었지만 사용자가 brain
 * walking 도중에만 참조하므로 본 모듈로 옮기는 게 자연스러움.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Company internal directories that should never be walked by brain RAG.
 *  Originally lived at the top of extension.ts; moved here because every
 *  use-site is brain-walking code (graph-builder, rag-context). */
export const COMPANY_INTERNAL_DIRS = new Set(['_cache', '_tmp']);

/* Recursively list .md files under a root, capped depth + count for safety.
   Skips company-internal folders + .git so we don't pull in identity.md /
   memory.md (those are added separately). */
export function _walkBrainMd(root: string, opts: { maxDepth: number; maxFiles: number; skipDirs: Set<string> }): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < opts.maxFiles) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (out.length >= opts.maxFiles) break;
      const full = path.join(cur.dir, e.name);
      if (e.isDirectory()) {
        if (opts.skipDirs.has(e.name)) continue;
        if (e.name.startsWith('.')) continue; /* skip dotfiles like .git */
        if (cur.depth + 1 <= opts.maxDepth) stack.push({ dir: full, depth: cur.depth + 1 });
      } else if (e.isFile() && (e.name.toLowerCase().endsWith('.md') || e.name.toLowerCase().endsWith('.txt'))) {
        out.push(full);
      }
    }
  }
  return out;
}
