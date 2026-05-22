/**
 * Centralized prompt constants.
 *
 * extension.ts had ~10 `const FOO_PROMPT = _loadPrompt('foo.md')` lines
 * sprinkled across the file. This barrel centralizes them so:
 *   - All prompt sources live in one importable place
 *   - Bundle / lazy-load behavior can be tuned in one shot
 *   - Cycle 5+ extractions can grab a prompt without touching extension.ts
 *
 * Loader semantics match the original `_loadPrompt`:
 *   - Reads `assets/prompts/<name>.md` synchronously at module init
 *   - Returns empty string on failure (logged to console)
 *   - Cached per-file so repeated imports cost nothing
 *
 * NOTE: this module DOES NOT depend on '../extension'. It is a leaf module
 * that other extracted modules (e.g. src/telegram/dispatch.ts) can import
 * without causing circular deps.
 */

import * as fs from 'fs';
import * as path from 'path';

/* esbuild 번들 출력 위치(extension/out)이라 ../assets/prompts 로 한 단계 위.
   모든 모듈이 같은 번들 (out/extension.js) 로 합쳐지므로 다른 src/* 모듈도
   동일하게 단일 `..` 를 쓴다 (e.g. src/seeds/common.ts 참조). */
const _PROMPTS_DIR = path.join(__dirname, '..', 'assets', 'prompts');
const _promptCache = new Map<string, string>();

function _loadPrompt(file: string): string {
    let cached = _promptCache.get(file);
    if (cached !== undefined) return cached;
    try {
        cached = fs.readFileSync(path.join(_PROMPTS_DIR, file), 'utf-8');
    } catch (e: any) {
        console.error(`[Agent OS] prompt 로드 실패 ${file}:`, e?.message || e);
        cached = '';
    }
    _promptCache.set(file, cached);
    return cached;
}

export const SYSTEM_PROMPT = _loadPrompt('system.md');
export const CEO_CLASSIFIER_PROMPT = _loadPrompt('ceo-classifier.md');
export const SECRETARY_TELEGRAM_PROMPT = _loadPrompt('secretary-telegram.md');
export const SKILL_DISTILL_PROMPT = _loadPrompt('skill-distill.md');
export const CEO_PLANNER_PROMPT = _loadPrompt('ceo-planner.md');
export const CEO_CHAT_PROMPT = _loadPrompt('ceo-chat.md');
export const SECRETARY_TRIAGE_PROMPT = _loadPrompt('secretary-triage.md');
export const CEO_REPORT_PROMPT = _loadPrompt('ceo-report.md');
export const CONFER_PROMPT = _loadPrompt('confer.md');
export const DECISIONS_EXTRACT_PROMPT = _loadPrompt('decisions-extract.md');
