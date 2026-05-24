/* POST /api/preorder — 폼 제출 → Supabase preorders 테이블 insert (status=pending).
   응답에 row id 반환 → 클라이언트가 /preorder?id=... 로 라우팅.
   런타임: Node (Supabase JS client). */
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';

interface PreorderBody {
    email?: string;
    name?: string;
    phone4?: string;
    account4?: string | null;
    campaign_id?: string | null;
    project_key?: string | null;
}

function bad(msg: string, status = 400) {
    return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function POST(req: Request) {
    let body: PreorderBody;
    try { body = await req.json(); }
    catch { return bad('JSON 파싱 실패'); }

    const email = (body.email || '').trim().toLowerCase();
    const name = (body.name || '').trim();
    const phone4 = (body.phone4 || '').trim();
    const account4 = body.account4 ? String(body.account4).trim() : null;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('유효한 이메일이 필요해요');
    if (!name || name.length < 2 || name.length > 20) return bad('이름은 2~20자');
    if (!/^\d{4}$/.test(phone4)) return bad('전화 끝 4자리는 숫자 4개');
    if (account4 && !/^\d{4}$/.test(account4)) return bad('계좌 끝 4자리는 숫자 4개');

    const row = {
        email, name, phone4, account4,
        campaign_id: body.campaign_id || null,
        project_key: body.project_key || null,
        status: 'pending' as const,
        price_krw: Number(process.env.NEXT_PUBLIC_PREORDER_PRICE || 4900),
        /* IP/UA 는 fraud 감지·중복 방지에 유용. 개인정보는 짧게만. */
        ip_hint: (req.headers.get('x-forwarded-for') || '').split(',')[0].trim().slice(0, 45) || null,
        ua_hint: (req.headers.get('user-agent') || '').slice(0, 120) || null,
    };

    const { data, error } = await supabase
        .from('preorders')
        .insert(row)
        .select('id')
        .single();

    if (error) {
        console.error('[preorder] insert failed', error);
        return bad(error.message || 'DB 저장 실패', 500);
    }
    return NextResponse.json({ ok: true, id: data?.id });
}
