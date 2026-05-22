/**
 * Telegram pure/state modules barrel.
 *
 * extension.ts 에서 분리된 Telegram 도우미들을 한 곳으로 묶음. 네트워크/HTTP
 * 호출은 다른 모듈(추출 예정)에서 담당; 여기서는 디스크/메모리만.
 */

export { markdownToTelegram } from './markdown';
export {
    HISTORY_MAX,
    historyPath,
    pushHistory,
    renderHistory,
    hydrateFromDisk,
} from './history';
export {
    LOCK_TTL_MS,
    lockPath,
    tryAcquireLock,
    releaseLockIfOwned,
} from './lock';
export {
    offsetPath,
    readOffset,
    writeOffset,
} from './offset';
export type { TelegramConfig } from './config';
export { readTelegramConfig } from './config';
export type { HttpClient } from './client';
export {
    defaultHttpClient,
    sendReport,
    sendLong,
    sendTyping,
} from './client';
export {
    handleTelegramCommand,
    handleTelegramViaSecretary,
} from './commands';
export {
    startTelegramPolling,
    stopTelegramPolling,
} from './polling';

/* Telegram dispatch helpers — capability/status reports + LLM dispatch utilities
   + casual chat / action-item / JSON parsing helpers. Extracted in cycle 8.
   Depends on '../extension'. */
export {
    TELEGRAM_HELP,
    _modelToTier,
    _serializeMessages,
    _quickLLMCall,
    classifyToAgent,
    _extractFirstJsonObject,
    _buildCapabilityReport,
    _buildDispatchStatusReport,
    _isCasualChat,
    _harvestActionItems,
} from './dispatch';
