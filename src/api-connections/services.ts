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
        summary: '비서가 텔레그램으로 양방향 명령을 받고 보고합니다. 폰으로 어디서든 회사를 운영하세요.',
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
    {
        id: 'slack',
        name: 'Slack (양방향 대화)',
        icon: '💬',
        summary: '비서가 슬랙 채널에서 양방향 명령을 받고 보고. Socket Mode 라 컴퓨터만 켜져있으면 됩니다 (public URL · ngrok 불필요). 토큰은 _agents/secretary/config.md 에 저장되고 git 제외.',
        helpUrl: 'https://api.slack.com/apps',
        agentId: 'secretary',
        fields: [
            { key: 'SLACK_BOT_TOKEN', label: 'Bot Token (xoxb-…)', type: 'password', help: 'api.slack.com/apps → 본인 App → OAuth & Permissions → "Bot User OAuth Token". 권한 scope 최소: chat:write · channels:history · groups:history · im:history · app_mentions:read.' },
            { key: 'SLACK_APP_TOKEN', label: 'App-Level Token (xapp-…)', type: 'password', help: 'Socket Mode 용. App → Basic Information → App-Level Tokens → Generate → "connections:write" scope. 이거 있으면 webhook URL 필요 없음.' },
            { key: 'SLACK_DEFAULT_CHANNEL', label: '기본 채널 ID', type: 'text', placeholder: 'C01ABCDE234', help: '비서가 보고서·알림을 기본으로 보낼 채널. 채널 우클릭 → "Copy link" → URL 끝의 C로 시작하는 ID. 봇을 그 채널에 초대(/invite @bot)해야 동작.' },
            { key: 'SLACK_SIGNING_SECRET', label: 'Signing Secret (선택)', type: 'password', help: 'Socket Mode 만 쓰면 불필요. HTTP webhook 도 같이 쓸 때만 필요 (App → Basic Information → Signing Secret).' },
        ],
    },
    {
        id: 'openai',
        name: 'OpenAI (GPT · DALL·E · Whisper)',
        icon: '🧠',
        summary: 'OpenAI API 호출용 키. content-bot 키트·카피 생성·이미지 생성에서 사용. 키는 회사 폴더(_agents/business/config.md)에만 저장되고 .gitignore 로 git 제외 — 외부 노출 없음. 사용량 한도는 platform.openai.com/account/limits 에서 설정 권장.',
        helpUrl: 'https://platform.openai.com/api-keys',
        agentId: 'business',
        fields: [
            { key: 'OPENAI_API_KEY', label: 'API Key', type: 'password', help: 'platform.openai.com/api-keys 에서 "Create new secret key" — sk-proj- 또는 sk- 로 시작.' },
            { key: 'OPENAI_ORG_ID', label: 'Organization ID (선택)', type: 'text', placeholder: 'org-...', help: '여러 organization 에 속할 때만 필요. 개인 계정은 비워둬도 OK.' },
            { key: 'OPENAI_TEXT_MODEL', label: '기본 텍스트 모델', type: 'text', placeholder: 'gpt-5.1-mini', help: '비우면 gpt-5.1-mini (가성비). 또는 gpt-5.1, gpt-5.1-nano.' },
            { key: 'OPENAI_IMAGE_MODEL', label: '이미지 모델', type: 'text', placeholder: 'gpt-image-1', help: '비우면 gpt-image-1 (현재 표준). DALL·E 3 호환.' },
        ],
    },
    {
        id: 'x-twitter',
        name: 'X (Twitter) API v2',
        icon: '𝕏',
        summary: '미스터비스트(Head of Video)가 Shorts 클립을 X 에 자동 게시·트렌드 분석. Free tier 는 read 만, Basic 이상이면 post 가능. 토큰들은 회사 폴더 _agents/instagram/config.md 에 저장되고 git 제외.',
        helpUrl: 'https://developer.x.com/en/portal/dashboard',
        agentId: 'instagram',
        fields: [
            { key: 'X_BEARER_TOKEN', label: 'Bearer Token (필수)', type: 'password', help: 'Developer Portal → 본인 App → Keys and tokens → Bearer Token. Read-only 용도라면 이것만 있어도 충분.' },
            { key: 'X_API_KEY', label: 'API Key (Consumer Key)', type: 'password', help: 'OAuth 1.0a 게시용. App → Keys and tokens → API Key & Secret.' },
            { key: 'X_API_SECRET', label: 'API Key Secret', type: 'password', help: '위 API Key 옆에 같이 발급되는 secret.' },
            { key: 'X_ACCESS_TOKEN', label: 'Access Token (게시용)', type: 'password', help: 'App → Keys and tokens → Access Token & Secret. "Read and Write" 권한으로 발급.' },
            { key: 'X_ACCESS_TOKEN_SECRET', label: 'Access Token Secret', type: 'password' },
        ],
    },
    {
        id: 'threads',
        name: 'Threads (Meta Graph API)',
        icon: '🧵',
        summary: '미스터비스트(Head of Video)가 Shorts 부산물을 Threads 에 자동 크로스포스트. Meta for Developers → Threads API → Long-lived access token (60일 자동 갱신). 토큰은 회사 폴더 _agents/instagram/config.md 에 저장되고 git 제외.',
        helpUrl: 'https://developers.facebook.com/docs/threads',
        agentId: 'instagram',
        fields: [
            { key: 'THREADS_ACCESS_TOKEN', label: 'Long-lived Access Token', type: 'password', help: 'Meta for Developers → My Apps → Threads → Threads API setup → Generate Access Token (Long-lived, 60일).' },
            { key: 'THREADS_USER_ID', label: 'Threads User ID', type: 'text', placeholder: '17841...', help: '같은 화면에서 표시되는 숫자 ID. 게시 endpoint URL 에 박힘.' },
            { key: 'THREADS_APP_ID', label: 'App ID (선택)', type: 'text', help: 'Long-lived token 자동 갱신용. 비우면 60일마다 수동 재발급.' },
            { key: 'THREADS_APP_SECRET', label: 'App Secret (선택)', type: 'password', help: '위 App ID 와 짝. 갱신 호출에 사용. 절대 외부 노출 금지 (이 패널은 로컬 파일에만 기록).' },
        ],
    },
];
