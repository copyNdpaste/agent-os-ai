/* 결제 안내 페이지 (RSC) — 폼 제출 후 도착. 송금 안내 + 계좌 복사.
   URL ?id=<preorder_id> 로 식별. 송금 후 직원이 SMS 파싱으로 자동 매칭.

   Next.js 15+: searchParams 는 async (await 필수). */
import Link from 'next/link';
import CopyButton from '../components/CopyButton';

const env = {
  bank: process.env.NEXT_PUBLIC_BANK_NAME || '토스뱅크',
  account: process.env.NEXT_PUBLIC_BANK_ACCOUNT || '0000-0000-0000',
  holder: process.env.NEXT_PUBLIC_BANK_HOLDER || '예금주',
  price: process.env.NEXT_PUBLIC_PREORDER_PRICE || '4900',
  ideaName: process.env.NEXT_PUBLIC_IDEA_NAME || '아이디어',
};

const fmt = (s: string) => Number(s).toLocaleString('ko-KR');

export default async function PreorderPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id = '' } = await searchParams;

  return (
    <main className="min-h-screen">
      <section className="max-w-2xl mx-auto px-6 py-16 sm:py-24">
        <div className="text-center mb-8">
          <div className="inline-block bg-green-100 text-green-700 px-4 py-2 rounded-full text-sm font-medium mb-4">
            ✓ 사전예약 등록됨 — 송금 1단계 남음
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold mb-2">{fmt(env.price)}원 송금하시면 끝</h1>
          <p className="text-[var(--text-dim)]">
            폼에 입력하신 <strong>이름 그대로</strong> 보내주세요. 자동으로 매칭됩니다.
          </p>
        </div>

        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 mb-6">
          <div className="text-xs uppercase tracking-wide text-[var(--text-dim)] mb-1">은행</div>
          <div className="text-xl font-bold mb-4">{env.bank}</div>

          <div className="text-xs uppercase tracking-wide text-[var(--text-dim)] mb-1">계좌번호</div>
          <div className="flex items-center gap-3 mb-4">
            <div className="text-2xl font-mono font-bold flex-1 select-all">{env.account}</div>
            <CopyButton text={env.account.replace(/-/g, '')} label="복사" />
          </div>

          <div className="text-xs uppercase tracking-wide text-[var(--text-dim)] mb-1">예금주</div>
          <div className="text-lg font-medium mb-4">{env.holder}</div>

          <div className="text-xs uppercase tracking-wide text-[var(--text-dim)] mb-1">금액</div>
          <div className="text-3xl font-bold text-brand">{fmt(env.price)}원</div>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900 mb-6">
          <p className="font-semibold mb-2">⚠️ 송금 전 꼭 확인</p>
          <ul className="list-disc list-inside space-y-1">
            <li>송금하실 때 <strong>입력한 이름과 동일</strong>하게 보내주세요 (자동 매칭용)</li>
            <li>금액 정확히 <strong>{fmt(env.price)}원</strong></li>
            <li>1~5분 이내 확정 이메일이 옵니다</li>
            <li>안 오면: 입력하신 이메일로 문의 답변 드림</li>
          </ul>
        </div>

        {id && (
          <p className="text-xs text-center text-[var(--text-dim)]">사전예약 ID: <code>{id}</code></p>
        )}

        <div className="text-center mt-12">
          <Link href="/" className="text-sm text-brand hover:underline">← 다시 보기</Link>
        </div>
      </section>
    </main>
  );
}
