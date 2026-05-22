/**
 * API connections — 외부 통합 자격증명 폼의 schema 타입.
 *
 * extension.ts 의 ApiConnectionsPanel 이 사용하는 single full-screen webview
 * 의 필드 정의. 사용자가 채우는 모든 통합 자격(텔레그램·YouTube·Calendar·
 * GitHub·PayPal·Gemini 등) 을 한 자리에 모은다.
 *
 * - ApiServiceField: 한 입력 필드 (text/password/select).
 * - ApiServiceDef:   한 서비스 (id + agentId + fields[] + 선택적 wizard).
 *
 * 별도 type 모듈로 뺀 이유는 services.ts 의 lookup 테이블이 storage.ts 에서
 * 도 import 되기 때문 — interface 만 가벼운 곳에 따로 두면 circular 위험 0.
 */

export interface ApiServiceField {
    key: string;
    label: string;
    type: 'text' | 'password' | 'select';
    placeholder?: string;
    help?: string;
    /** v2.89.140 — type='select' 일 때 선택지. 예: ['sandbox', 'live']. */
    options?: string[];
}

export interface ApiServiceDef {
    id: string;
    name: string;
    icon: string;
    summary: string;
    helpUrl?: string;
    /* `_agents/<agentId>/config.md` is where the values land. */
    agentId: string;
    fields: ApiServiceField[];
    /* Optional command to launch a guided OAuth wizard (e.g. Google Calendar). */
    wizardCommand?: string;
    /* When true, the service shows as "준비 중" — fields disabled, no save. */
    comingSoon?: boolean;
}

/** saveApiConnection 결과 — UI 가 노트/에러 표시에 사용. */
export interface SaveApiConnectionResult {
    ok: boolean;
    error?: string;
    note?: string;
}
