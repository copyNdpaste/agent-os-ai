/* Revenue command center — 통합 데이터 모델.
   3가지 데이터 소스 결합: 광고비 (캠페인) + 결제 (입금/PayPal/Stripe) +
   프로젝트 매핑 → 시장별·프로젝트별·캠페인별 ROI 자동 계산.

   저장 위치 (회사 폴더 안):
   - <companyDir>/_agents/business/data/ad_spend.json    캠페인 + 광고비
   - <companyDir>/_agents/business/data/incomes.json     한국 입금 (macOS Messages 파싱)
   - PayPal 매출은 기존 paypal_revenue.py JSON 그대로 (소스 변경 없음)

   다중 소스가 단일 view 로 합쳐지는 곳: src/revenue/aggregate.ts */

/** 캠페인 = 1개 아이디어를 특정 시장·플랫폼에서 송출한 단위. */
export interface Campaign {
    /** 안정적 id. 직원이 launch 명령 받을 때 자동 생성 (예: ca_2026-05-24_alphaai_kr_01) */
    id: string;
    /** 프로젝트 키 — workspace 의 .agent-os-ai/project.json name 와 매칭 */
    project: string;
    /** 한 줄 아이디어 설명 (예: "AI 자기소개서 첨삭 30초") */
    idea: string;
    /** 'KR' | 'US' | 'EU' (UK·DE·NL·북유럽 묶음). 동남아 등은 회사 정책상 제외 권장 */
    market: 'KR' | 'US' | 'EU' | string;
    /** Meta | Google | TikTok | X | 기타 */
    ad_platform: string;
    /** 시작·종료 (ISO 8601). 종료 미정이면 end_date null */
    start_date: string;
    end_date: string | null;
    /** active | killed | extended | completed */
    status: 'active' | 'killed' | 'extended' | 'completed';
    /** 일별 광고 지출 (ISO date → 금액 USD 환산). 미국·유럽은 자체 USD, 한국은 KRW 입력값을 USD 로 환산 저장 (FX_RATE 표 사용) */
    daily_spend: Record<string, number>;
    /** 누적 광고비 (USD). daily_spend 의 합 — 캐시용. */
    total_spent_usd: number;
    /** 랜딩페이지 URL — funnel 추적. */
    landing_url?: string;
    /** 결제 채널 (예: ["account-transfer-kr", "stripe"]) */
    payment_methods?: string[];
    /** 광고 → 클릭 (Meta Pixel/UTM 또는 수동) */
    clicks?: number;
    /** 클릭 → 랜딩페이지 visits */
    landing_visits?: number;
    /** 랜딩 → 결제 시도 (폼 제출 또는 결제 버튼) */
    payment_attempts?: number;
    /** 자유 노트 — 직원이 의사결정 흔적 남길 때 */
    notes?: string;
    /** 생성/수정 시각 (ISO) */
    created_at: string;
    updated_at: string;
}

/** 결제 1건 — 어디서 들어왔든 다 같은 shape 로 통합. */
export interface Income {
    id: string;
    /** 캠페인과 매핑 — 결제가 어느 캠페인에서 발생했는지. 미스 (자연 매출 등) 면 null */
    campaign_id: string | null;
    /** 프로젝트 키 — campaign_id 있으면 거기서 derived, 없으면 직접 지정 */
    project: string | null;
    /** ISO timestamp */
    ts: string;
    /** 금액 (소스 통화 그대로) */
    amount: number;
    /** 'KRW' | 'USD' | 'EUR' 등 */
    currency: string;
    /** USD 환산 (KRW → USD 같은 정규화). FX rate 는 store 에서 계산. */
    amount_usd: number;
    /** 'paypal' | 'stripe' | 'account-transfer-kr' | 'manual' */
    source: 'paypal' | 'stripe' | 'account-transfer-kr' | 'manual' | string;
    /** 송금인 단서 (이름 마스킹/끝자리). 한국 입금 SMS 에서 추출. 식별 정보는 한 글자만 (예: "홍**" → "홍") */
    payer_hint?: string;
    /** 파싱 원본 텍스트 — 디버깅·재처리 용도. 보안: 개인정보 (이름·전화) 마스킹 후 저장 */
    raw_snippet?: string;
}

/** 광고비/캠페인 store 의 파일 전체. */
export interface AdSpendFile {
    /** 스키마 버전 — 미래 마이그레이션 대비 */
    version: 1;
    campaigns: Campaign[];
    /** FX rate 캐시 (USD per 1 unit). 1 KRW = ~0.00073 USD 식. 매일 갱신 권장. */
    fx_rates: Record<string, number>;
    fx_rates_updated_at: string;
}

/** 입금 store 의 파일 전체. */
export interface IncomesFile {
    version: 1;
    incomes: Income[];
    /** macOS Messages 마지막 파싱 시점 (ROWID 또는 timestamp). 다음 파싱은 이 이후만. */
    last_parsed_ts?: string;
    last_parsed_rowid?: number;
}

/** ROI 집계 결과 — 대시보드가 받는 shape. */
export interface RoiSummary {
    /** 총 광고비 (USD) */
    total_ad_spend_usd: number;
    /** 총 매출 (USD, 모든 소스 합산) */
    total_revenue_usd: number;
    /** 순이익 = 매출 - 광고비 */
    net_profit_usd: number;
    /** ROI % = (매출 - 광고비) / 광고비 * 100. 광고비 0 이면 null */
    roi_pct: number | null;
    /** 활성 캠페인 수 */
    active_campaigns: number;
    /** 결제 발생 캠페인 수 (광고비 회수 단서) */
    paying_campaigns: number;
    /** 프로젝트별 분해 */
    by_project: Record<string, ProjectRoi>;
    /** 시장별 분해 (KR / US / EU) */
    by_market: Record<string, MarketRoi>;
}

export interface ProjectRoi {
    project: string;
    ad_spend_usd: number;
    revenue_usd: number;
    net_profit_usd: number;
    roi_pct: number | null;
    campaign_count: number;
    income_count: number;
}

export interface MarketRoi {
    market: string;
    ad_spend_usd: number;
    revenue_usd: number;
    net_profit_usd: number;
    roi_pct: number | null;
}
