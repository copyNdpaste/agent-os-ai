/**
 * API connections 도메인 barrel.
 *
 * extension.ts 의 외부 통합 자격증명 폼 (Telegram·YouTube·Calendar·GitHub·
 * PayPal·Gemini ...) 의 schema + per-companyDir 저장소를 한 묶음으로 추출.
 */

export type {
    ApiServiceField,
    ApiServiceDef,
    SaveApiConnectionResult,
} from './types';

export { API_SERVICES } from './services';

export {
    readAllApiConnections,
    saveApiConnection,
} from './storage';
