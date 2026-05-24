'use client';
/* 사전예약 폼 — 이메일·이름·전화 끝4자리 수집.
   제출 시 /api/preorder POST → Supabase preorders 테이블에 pending 등록.
   성공 응답에 preorder_id 받아서 /preorder?id=... 로 이동 (송금 안내). */
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function PreorderForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone4, setPhone4] = useState('');
  const [account4, setAccount4] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !name.trim() || phone4.length !== 4) {
      setError('이메일·이름·전화번호 끝 4자리는 필수입니다');
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch('/api/preorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim(),
          phone4,
          account4: account4 || null,
          campaign_id: process.env.NEXT_PUBLIC_CAMPAIGN_ID || null,
          project_key: process.env.NEXT_PUBLIC_PROJECT_KEY || null,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j?.id) {
        throw new Error(j?.error || '서버 오류');
      }
      router.push(`/preorder?id=${j.id}`);
    } catch (e: any) {
      setError(e?.message || String(e));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">이메일 *</label>
        <input
          type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:border-brand focus:ring-1 focus:ring-brand outline-none"
        />
        <p className="text-xs text-[var(--text-dim)] mt-1">확정 안내·출시 알림용</p>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">이름 *</label>
        <input
          type="text" required value={name} onChange={(e) => setName(e.target.value)}
          placeholder="홍길동"
          className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:border-brand focus:ring-1 focus:ring-brand outline-none"
        />
        <p className="text-xs text-[var(--text-dim)] mt-1">💡 송금하실 때 보내실 이름과 동일해야 자동 확인됩니다</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium mb-1">전화 끝 4자리 *</label>
          <input
            type="tel" required maxLength={4} pattern="\d{4}" value={phone4}
            onChange={(e) => setPhone4(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="0000"
            className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:border-brand focus:ring-1 focus:ring-brand outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">계좌 끝 4자리</label>
          <input
            type="tel" maxLength={4} pattern="\d{4}" value={account4}
            onChange={(e) => setAccount4(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="환불용 (선택)"
            className="w-full px-4 py-3 border border-slate-200 rounded-lg focus:border-brand focus:ring-1 focus:ring-brand outline-none"
          />
        </div>
      </div>

      {error && <p className="text-sm text-red-600">⚠️ {error}</p>}

      <button
        type="submit" disabled={submitting}
        className="w-full bg-brand hover:bg-brand-dark text-white py-4 rounded-lg font-semibold text-lg transition disabled:opacity-50"
      >
        {submitting ? '처리 중…' : '얼리버드 사전예약 진행 →'}
      </button>
    </form>
  );
}
