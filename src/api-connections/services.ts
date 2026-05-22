/**
 * API_SERVICES 룩업 테이블 — 외부 통합 서비스 정의.
 *
 * extension.ts 에서 byte-for-byte 복사. 리팩토링 없음 — 필드 라벨/키
 * 이름/help 문구까지 모두 보존. 데이터만 있는 파일.
 *
 * 소비자:
 *   - storage.ts 의 readAllApiConnections / saveApiConnection
 *   - views/api-connections 패널 (폼 렌더링)
 */
import type { ApiServiceDef } from './types';

export const API_SERVICES: ApiServiceDef[] = [
    {
        id: 'telegram',
        name: '텔레그램 봇',
        icon: '📨',
        summary: '비서가 텔레그램으로 양방향 명령을 받고 보고합니다. 폰 어디서든 회사를 운영하세요.',
        helpUrl: 'https://t.me/BotFather',
        agentId: 'secretary',
        fields: [
            { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', type: 'password', help: '@BotFather에서 /newbot으로 발급. 형식: 숫자:문자' },
            { key: 'TELEGRAM_CHAT_ID', label: 'Chat ID', type: 'text', placeholder: '비워두면 자동 감지', help: '봇한테 메시지 1번 보내고 비워둔 채 저장하면 자동으로 채워집니다' },
        ],
    },
    {
        id: 'youtube',
        name: 'YouTube Data API',
        icon: '📺',
        summary: '내 채널 + 경쟁 채널 분석, 댓글 답장 큐 생성. 시청 지속률 같은 비공개 데이터는 OAuth가 별도.',
        helpUrl: 'https://console.cloud.google.com/',
        agentId: 'youtube',
        fields: [
            { key: 'YOUTUBE_API_KEY', label: 'API Key', type: 'password', help: 'Cloud Console → YouTube Data API v3 → 사용자 인증 정보 → API 키' },
            { key: 'YOUTUBE_CHANNEL_ID', label: 'Channel ID', type: 'text', placeholder: 'UCxxx...', help: '내 채널 페이지에서 확인' },
        ],
    },
    {
        id: 'youtube-oauth',
        name: 'YouTube Analytics (OAuth)',
        icon: '📊',
        summary: '시청 지속률 · 트래픽 소스 · 시청자 인구통계. Client ID/Secret 채운 뒤 "OAuth 연결" 버튼 (또는 에이전트가 자동으로 발동).',
        helpUrl: 'https://console.cloud.google.com/',
        agentId: 'youtube',
        wizardCommand: 'agentOs.youtube.connectOAuth',
        fields: [
            { key: 'YOUTUBE_OAUTH_CLIENT_ID', label: 'Client ID', type: 'password' },
            { key: 'YOUTUBE_OAUTH_CLIENT_SECRET', label: 'Client Secret', type: 'password', help: 'Authorized redirect URI: http://127.0.0.1:5814/yt-oauth-callback' },
        ],
    },
    {
        id: 'google-calendar',
        name: 'Google Calendar',
        icon: '📅',
        summary: '비서가 사용자 일정을 읽고 자동으로 task 마감일과 동기화합니다.',
        agentId: 'secretary',
        wizardCommand: 'agent-os.connectGoogleCalendarWrite',
        fields: [
            { key: 'GOOGLE_CALENDAR_ID', label: 'Calendar ID', type: 'text', placeholder: 'primary 또는 yourcal@group.calendar.google.com', help: '명령 팔레트 → "Agent OS: Google Calendar 자동 일정 연결" 추천' },
        ],
    },
    {
        id: 'github',
        name: 'GitHub',
        icon: '💻',
        summary: 'Developer 에이전트가 이슈 읽고 코드 푸시. repo + workflow 권한 필요.',
        helpUrl: 'https://github.com/settings/tokens',
        agentId: 'developer',
        comingSoon: true,
        fields: [
            { key: 'GITHUB_TOKEN', label: 'Personal Access Token', type: 'password' },
            { key: 'GITHUB_DEFAULT_REPO', label: '기본 저장소', type: 'text', placeholder: 'owner/repo' },
        ],
    },
    {
        id: 'instagram',
        name: 'Instagram (Meta Graph)',
        icon: '📷',
        summary: '인스타 비즈니스 계정 게시 + DM/댓글 분석.',
        helpUrl: 'https://developers.facebook.com/',
        agentId: 'instagram',
        comingSoon: true,
        fields: [
            { key: 'META_ACCESS_TOKEN', label: 'Access Token', type: 'password' },
            { key: 'INSTAGRAM_BUSINESS_ID', label: 'Business Account ID', type: 'text' },
        ],
    },
    {
        id: 'paypal',
        name: 'PayPal (매출 분석)',
        icon: '💰',
        summary: '내 게임·서비스의 결제 거래를 분석. 매출 대시보드 + 새 결제 텔레그램 알림에 사용. Developer Dashboard에서 Client ID/Secret 발급.',
        helpUrl: 'https://developer.paypal.com/dashboard/applications',
        agentId: 'business',
        fields: [
            { key: 'PAYPAL_MODE', label: '모드', type: 'select', options: ['sandbox', 'live'], help: '테스트는 sandbox, 실제 결제는 live. ⚠️ Live 는 별도 자격증명 필요 — Developer Dashboard 좌상단 Sandbox/Live 토글 후 Live 앱에서 받은 Client ID/Secret 사용.' },
            { key: 'PAYPAL_CLIENT_ID', label: 'Client ID', type: 'password', help: 'Developer Dashboard → Apps & Credentials → 본인 앱 → Client ID' },
            { key: 'PAYPAL_CLIENT_SECRET', label: 'Client Secret', type: 'password', help: '같은 화면에서 Secret 복사 (Show 클릭)' },
            { key: 'PAYPAL_LOOKBACK_DAYS', label: '분석 기간 (일)', type: 'text', placeholder: '30', help: '비우면 30일. Transaction Search 한도 31일.' },
            { key: 'PAYPAL_CURRENCY', label: '기본 통화 (선택)', type: 'text', placeholder: 'USD', help: '비우면 모든 통화 표시. USD/KRW 등.' },
        ],
    },
    {
        id: 'gemini',
        name: 'Google Gemini (AI 텍스트 + 이미지)',
        icon: '✨',
        summary: '운영자의 1인 기업 서비스에서 Gemini AI 호출 (텍스트 + Imagen 3 이미지). 키트 자동 적용 시 HTML 에 자동 inline 박힘. 보안: Google Cloud Console 에서 HTTP Referer 제한 권장.',
        helpUrl: 'https://aistudio.google.com/apikey',
        agentId: 'business',
        fields: [
            { key: 'GEMINI_API_KEY', label: 'API Key', type: 'password', help: 'aistudio.google.com/apikey 에서 Create API key (무료 tier OK). 이 키가 pack_apply 가 키트에 자동 박아 넣음 — 운영자의 강아지 사주·이미지 생성 서비스 등.' },
            { key: 'GEMINI_TEXT_MODEL', label: '텍스트 모델', type: 'text', placeholder: 'gemini-3.1-flash-lite-preview', help: '비우면 기본 gemini-3.1-flash-lite-preview (가성비·1M context·멀티모달). 또는 gemini-3.1-flash, gemini-3.1-pro.' },
            { key: 'GEMINI_IMAGE_MODEL', label: '이미지 모델', type: 'text', placeholder: 'gemini-3.1-flash-image-preview', help: '비우면 기본 gemini-3.1-flash-image-preview (text+image multimodal). 이미지 생성 안 쓸 거면 비워둠.' },
        ],
    },
];
