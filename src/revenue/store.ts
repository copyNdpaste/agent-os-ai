/* Revenue store — ad_spend.json + incomes.json 의 atomic read/write.
   PayPal JSON 은 paypal_revenue.py 가 관리하므로 여기서 안 건드림. */
import * as fs from 'fs';
import * as path from 'path';
import type { AdSpendFile, IncomesFile, Campaign, Income } from './types';

/** 모든 store 가 회사 폴더의 같은 위치에 저장. business 에이전트 도구와 같은 dir. */
function dataDir(companyDir: string): string {
    return path.join(companyDir, '_agents', 'business', 'data');
}
function adSpendPath(companyDir: string): string { return path.join(dataDir(companyDir), 'ad_spend.json'); }
function incomesPath(companyDir: string): string { return path.join(dataDir(companyDir), 'incomes.json'); }

function ensureDir(p: string): void {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function atomicWrite(file: string, content: string): void {
    ensureDir(path.dirname(file));
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, file);
}

/* ── Ad spend / campaigns ────────────────────────────────────────────── */

const DEFAULT_FX: Record<string, number> = {
    /* 1 unit → USD. 정기 업데이트 권장. 환율 fetch 는 future. */
    USD: 1,
    KRW: 0.00073,
    EUR: 1.07,
    GBP: 1.27,
    JPY: 0.0065,
};

export function readAdSpend(companyDir: string): AdSpendFile {
    const file = adSpendPath(companyDir);
    if (!fs.existsSync(file)) {
        return { version: 1, campaigns: [], fx_rates: { ...DEFAULT_FX }, fx_rates_updated_at: new Date().toISOString() };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (raw?.version !== 1 || !Array.isArray(raw.campaigns)) {
            return { version: 1, campaigns: [], fx_rates: { ...DEFAULT_FX }, fx_rates_updated_at: new Date().toISOString() };
        }
        return {
            version: 1,
            campaigns: raw.campaigns,
            fx_rates: raw.fx_rates || { ...DEFAULT_FX },
            fx_rates_updated_at: raw.fx_rates_updated_at || new Date().toISOString(),
        };
    } catch {
        return { version: 1, campaigns: [], fx_rates: { ...DEFAULT_FX }, fx_rates_updated_at: new Date().toISOString() };
    }
}

export function writeAdSpend(companyDir: string, data: AdSpendFile): void {
    atomicWrite(adSpendPath(companyDir), JSON.stringify(data, null, 2));
}

export function upsertCampaign(companyDir: string, c: Campaign): void {
    const data = readAdSpend(companyDir);
    const i = data.campaigns.findIndex(x => x.id === c.id);
    if (i >= 0) data.campaigns[i] = c;
    else data.campaigns.push(c);
    writeAdSpend(companyDir, data);
}

/** 캠페인의 일별 광고비 한 줄 누적 (직원이 launch loop 에서 매일 호출). */
export function addDailySpend(companyDir: string, campaignId: string, date: string, amount: number, currency: string): void {
    const data = readAdSpend(companyDir);
    const c = data.campaigns.find(x => x.id === campaignId);
    if (!c) throw new Error(`캠페인 못 찾음: ${campaignId}`);
    const rate = data.fx_rates[currency] ?? 1;
    const usd = amount * rate;
    c.daily_spend[date] = (c.daily_spend[date] || 0) + usd;
    c.total_spent_usd = Object.values(c.daily_spend).reduce((a, b) => a + b, 0);
    c.updated_at = new Date().toISOString();
    writeAdSpend(companyDir, data);
}

/* ── Incomes ─────────────────────────────────────────────────────────── */

export function readIncomes(companyDir: string): IncomesFile {
    const file = incomesPath(companyDir);
    if (!fs.existsSync(file)) {
        return { version: 1, incomes: [] };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (raw?.version !== 1 || !Array.isArray(raw.incomes)) {
            return { version: 1, incomes: [] };
        }
        return raw as IncomesFile;
    } catch {
        return { version: 1, incomes: [] };
    }
}

export function writeIncomes(companyDir: string, data: IncomesFile): void {
    atomicWrite(incomesPath(companyDir), JSON.stringify(data, null, 2));
}

/** 새 입금 1건 추가. id 중복이면 skip (idempotent — 같은 SMS 재파싱 안전). */
export function addIncome(companyDir: string, inc: Income): boolean {
    const data = readIncomes(companyDir);
    if (data.incomes.some(x => x.id === inc.id)) return false;
    /* USD 환산 보정 — caller 가 amount_usd 안 채웠으면 fx 로 계산 */
    if (!inc.amount_usd) {
        const fx = readAdSpend(companyDir).fx_rates[inc.currency] ?? 1;
        inc.amount_usd = inc.amount * fx;
    }
    data.incomes.push(inc);
    writeIncomes(companyDir, data);
    return true;
}

/** 여러 건 한꺼번에. 중복 자동 제외, 추가된 개수 반환. */
export function addIncomesBatch(companyDir: string, list: Income[]): number {
    if (!list.length) return 0;
    const data = readIncomes(companyDir);
    const existing = new Set(data.incomes.map(x => x.id));
    const fx = readAdSpend(companyDir).fx_rates;
    let added = 0;
    for (const inc of list) {
        if (existing.has(inc.id)) continue;
        if (!inc.amount_usd) inc.amount_usd = inc.amount * (fx[inc.currency] ?? 1);
        data.incomes.push(inc);
        existing.add(inc.id);
        added++;
    }
    if (added > 0) writeIncomes(companyDir, data);
    return added;
}

/** 마지막 파싱 위치 업데이트 (다음 watcher tick 이 그 이후만 읽도록). */
export function updateLastParsedCheckpoint(companyDir: string, rowid: number, ts: string): void {
    const data = readIncomes(companyDir);
    data.last_parsed_rowid = rowid;
    data.last_parsed_ts = ts;
    writeIncomes(companyDir, data);
}
