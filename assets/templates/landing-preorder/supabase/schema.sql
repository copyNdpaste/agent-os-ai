-- preorders 테이블 — 사전예약 폼 제출 + 송금 매칭 상태 추적.
-- 사장님: Supabase 프로젝트 만든 후 SQL Editor 에 이 파일 통째로 붙여 실행.
-- 한 번만 실행. 이후 컬럼 추가 시에는 ALTER TABLE 따로.

create table if not exists public.preorders (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    -- 사용자 입력
    email text not null,
    name text not null,
    phone4 text not null,
    account4 text,

    -- 캠페인/프로젝트 추적
    campaign_id text,
    project_key text,

    -- 결제 상태 ──────────────────────────────────────────────────────
    -- pending: 폼 제출, 송금 대기
    -- paid: 입금 SMS 매칭 완료
    -- mismatch: 입금은 있지만 폼이랑 안 맞음 (사장님 수동 확인 필요)
    -- expired: 24h 송금 안 함, 자동 만료
    -- refunded: 환불 처리
    status text not null default 'pending'
        check (status in ('pending','paid','mismatch','expired','refunded')),

    price_krw integer not null,
    -- 입금 확인되면 채워지는 필드들
    paid_at timestamptz,
    paid_amount_krw integer,
    paid_source text,
    paid_raw_snippet text,

    -- fraud / 운영 단서 (개인정보 최소)
    ip_hint text,
    ua_hint text
);

-- 매칭 시 자주 조회: status=pending + 이름 + 시각 범위
create index if not exists preorders_match_idx
    on public.preorders (status, name, created_at)
    where status = 'pending';

-- 이메일 중복 방지 — 같은 이메일이 pending 상태로 여러 개면 가장 최근 1개만 유효 처리.
-- 강한 unique 는 안 검 (재시도/실수로 막힐 수 있음). app 단에서 처리.
create index if not exists preorders_email_idx on public.preorders (email);
create index if not exists preorders_campaign_idx on public.preorders (campaign_id);

-- updated_at 자동 갱신 trigger
create or replace function public.touch_preorder_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists preorders_touch_ua on public.preorders;
create trigger preorders_touch_ua
    before update on public.preorders
    for each row execute function public.touch_preorder_updated_at();

-- ── RLS (Row Level Security) ────────────────────────────────────────────
-- anon key 로 insert 만 허용. select/update 는 service_role 키만 (직원이 매칭할 때 사용).
alter table public.preorders enable row level security;

drop policy if exists preorders_anon_insert on public.preorders;
create policy preorders_anon_insert on public.preorders
    for insert
    to anon
    with check (true);

-- anon 은 자기가 방금 만든 row 도 못 봄 (이메일 enumerated 방지). 직원이 service_role 로 처리.
