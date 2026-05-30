#!/usr/bin/env node
/* PostHog 대시보드 + 전환 퍼널 1회 자동 생성 스크립트.
   ─────────────────────────────────────────────────────────────────────
   PostHog 계정에 "사전예약 추적" 대시보드 + 퍼널(방문→제출) + 일일 방문수
   insight 를 API 로 한 번에 만든다. UI 클릭 0번.

   personal API key 는 환경변수로만 받음 → 코드/깃에 안 남음 (사장님 셸에만).

   사용법 (랜딩 폴더에서):
     POSTHOG_HOST=https://us.posthog.com \
     POSTHOG_PROJECT_ID=12345 \
     POSTHOG_PERSONAL_API_KEY=phx_xxxxxxxx \
     node scripts/posthog-setup.mjs

   - POSTHOG_PROJECT_ID : PostHog → Settings → Project 의 "Project ID" 숫자
   - POSTHOG_PERSONAL_API_KEY : Settings → Personal API keys → Create
       scope 는 읽기/쓰기 최소만: dashboard:write, insight:write
   - POSTHOG_HOST : US Cloud 면 https://us.posthog.com (i. 없는 주소!)
                    EU Cloud 면 https://eu.posthog.com
   ───────────────────────────────────────────────────────────────────── */

/* ingestion host(us.i.posthog.com)를 실수로 넣어도 API host(us.posthog.com)로 보정. */
const HOST = (process.env.POSTHOG_HOST || 'https://us.posthog.com')
  .replace(/\/$/, '')
  .replace('.i.posthog.com', '.posthog.com');
const PROJECT_ID = process.env.POSTHOG_PROJECT_ID;
const KEY = process.env.POSTHOG_PERSONAL_API_KEY;
const IDEA = process.env.NEXT_PUBLIC_IDEA_NAME || '랜딩';

if (!PROJECT_ID || !KEY) {
  console.error('❌ POSTHOG_PROJECT_ID 와 POSTHOG_PERSONAL_API_KEY 가 필요합니다. (상단 사용법 참고)');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function post(path, body) {
  const r = await fetch(`${HOST}/api/projects/${PROJECT_ID}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = text; }
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}\n${typeof j === 'string' ? j : JSON.stringify(j, null, 2)}`);
  return j;
}

async function main() {
  const dash = await post('/dashboards/', {
    name: `${IDEA} — 사전예약 추적`,
    description: '자동 생성: 방문→사전예약 제출 전환 퍼널 + 일일 방문수.',
  });
  console.log('✅ 대시보드 생성: id =', dash.id);

  await post('/insights/', {
    name: '사전예약 전환 퍼널 (방문 → 제출)',
    dashboards: [dash.id],
    filters: {
      insight: 'FUNNELS',
      events: [
        { id: '$pageview', name: '$pageview', type: 'events', order: 0 },
        { id: 'preorder_submitted', name: 'preorder_submitted', type: 'events', order: 1 },
      ],
      funnel_viz_type: 'steps',
      date_from: '-30d',
    },
  });
  console.log('✅ 전환 퍼널 insight 생성');

  await post('/insights/', {
    name: '일일 방문수 ($pageview)',
    dashboards: [dash.id],
    filters: {
      insight: 'TRENDS',
      events: [{ id: '$pageview', name: '$pageview', type: 'events', order: 0 }],
      interval: 'day',
      date_from: '-30d',
    },
  });
  console.log('✅ 일일 방문수 insight 생성');

  console.log(`\n🎉 완료! 대시보드 열기: ${HOST}/project/${PROJECT_ID}/dashboard/${dash.id}`);
  console.log('   (데이터는 사이트에 방문/제출이 실제로 발생한 뒤부터 채워집니다)');
}

main().catch((e) => {
  console.error('❌ 실패:', e.message);
  process.exit(1);
});
