# Landing + Preorder 템플릿

아이디어 한 줄 → 랜딩 페이지 + 사전예약 폼 + 송금 안내 (4,900원 charm pricing
+ 얼리버드 메시지). Next.js 15 App Router + Supabase + Vercel.

## 사장님이 1회만 하실 셋업 (15~20분)

### 1) 토스뱅크 매출 전용 계좌 만들기 (5분)
- 토스 앱 → 토스뱅크 → 계좌 추가 → "매출 전용" 이름으로 새 계좌
- 계좌번호 메모 (예: `1000-1234-5678`)

### 2) Supabase 프로젝트 생성 (5분)
- https://supabase.com → New Project → 이름 자유, 비번 강하게
- 프로젝트 생성 후 **Settings → API** 에서 두 값 메모:
  - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
  - `anon` `public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- **SQL Editor → New query** → `supabase/schema.sql` 통째 복붙 → Run
  - `preorders` 테이블 + 인덱스 + RLS 정책 한 번에 만들어짐

### 3) Vercel 배포 + 환경변수 (5분)
- 이 폴더에서:

```bash
npm install
npx vercel link            # 처음만 — Vercel 계정/프로젝트 선택
npx vercel env add NEXT_PUBLIC_SUPABASE_URL          # 값 붙여넣기, production+preview 둘 다
npx vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
npx vercel env add NEXT_PUBLIC_BANK_NAME             # "토스뱅크"
npx vercel env add NEXT_PUBLIC_BANK_ACCOUNT          # "1000-1234-5678"
npx vercel env add NEXT_PUBLIC_BANK_HOLDER           # 사장님 이름
npx vercel env add NEXT_PUBLIC_BANK_HOLDER
npx vercel deploy --prod
```

- 배포 URL 확보 (예: `https://xyz.vercel.app`) → 광고 link 로 사용

### 4) 로컬 개발 (선택)

```bash
cp .env.example .env.local      # 값 채우기
npm run dev                     # http://localhost:3000
```

## 아이디어마다 갈아끼울 변수

`.env.local` (로컬) 또는 Vercel Dashboard (배포) 의 다음 변수만 바꾸면 같은
템플릿이 다른 모습으로 작동. 직원이 launch 명령 받을 때 자동 갱신.

```
NEXT_PUBLIC_IDEA_NAME           아이디어 이름
NEXT_PUBLIC_IDEA_TAGLINE        한 줄 설명
NEXT_PUBLIC_IDEA_VALUE_PROP     가치 제안 (왜 이걸 사야 하나)
NEXT_PUBLIC_TARGET_AUDIENCE     타깃 (For. 누구)
NEXT_PUBLIC_PREORDER_PRICE      얼리버드 가격 (기본 4900)
NEXT_PUBLIC_REGULAR_PRICE       정가 (기본 19900)
NEXT_PUBLIC_EARLYBIRD_QUOTA     한정 수량 (기본 100)
NEXT_PUBLIC_EARLYBIRD_BENEFIT   얼리버드 혜택 (예: 첫 3개월 무료)
NEXT_PUBLIC_REFUND_POLICY       환불 정책
NEXT_PUBLIC_CAMPAIGN_ID         캠페인 ID (직원이 자동 생성)
NEXT_PUBLIC_PROJECT_KEY         프로젝트 키 (예: alpha-agent-ai)
```

## funnel 구조

```
[광고] → [/ 랜딩] → 폼 제출 → POST /api/preorder → Supabase preorders insert
                                                 ↓
                                  /preorder?id=... 로 redirect
                                                 ↓
                                  [송금 안내 페이지] — 계좌 복사 + 금액
                                                 ↓
                                  사용자 토스 송금
                                                 ↓
                          (사장님 폰 SMS → mac Messages chat.db sync)
                                                 ↓
                          [직원 매칭 watcher — 다음 commit]
                                                 ↓
                          preorders.status = paid + 이메일 자동 발송
```

## 보안 메모

- `.env*.local` 은 .gitignore 에 포함 — 절대 commit X
- `service_role` Supabase 키는 직원 (extension 호스트) 에서만 쓰는 키. 이 템플릿 안엔 anon 키만.
- preorders 테이블은 RLS 켜둠 — anon 은 insert 만, 조회·수정은 service_role 필요.
- 사장님 회사 정책 (memory): 결제 정보 git commit 금지, API per-call 결제 금지.

## 다음 단계 (별도 commit 으로)

- macOS Messages chat.db 파싱 + 자동 매칭 (P2)
- 매칭 시 Resend 로 확정 이메일 자동 발송 (P3)
- 매출 컨트롤 센터 UI 에 광고비 + 결제 + ROI 통합 (P4)
- 직원이 "아이디어 X 검증해" 한 줄로 위 셋업 자동화 (장기)
