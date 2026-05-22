/**
 * Company 모듈 barrel.
 *
 * extension.ts 에서 분리된 company 관련 pure/state 헬퍼들을 한 곳으로 묶음.
 * 모든 public API 는 companyDir 를 인자로 받는다 — VS Code / 글로벌 상태 의존 없음.
 */

export type { CompanyMetrics } from './metrics';
export {
    metricsPath,
    readMetrics,
    updateMetrics,
    daysSinceFounding,
} from './metrics';

export {
    identityPath,
    extractCompanyNameFromMd,
    readCompanyName,
    isConfigured,
} from './identity';

export type { CompanyConfig } from './config';
export {
    configPath,
    extractField,
    extractGoalLine,
    readConfig,
    writeConfig,
} from './config';

/* Company directory structure + migrations + palette commands.
   Extracted from extension.ts in cycle 8. Depends on '../extension'. */
export {
    _migrateCompanyToSubdir,
    _migrateCompanyToBrain,
    _migrateYouTubeCredsToCanonical,
    ensureCompanyStructure,
    runConnectCompanyRepo,
    runChangeCompanyDir,
} from './structure';
