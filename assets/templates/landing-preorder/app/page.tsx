/* 랜딩 페이지 (RSC) — 환경변수로 아이디어/카피 주입.
   직원이 아이디어마다 .env.local 만 다시 채우면 같은 템플릿이 다른 모습으로 작동.
   인터랙티브한 폼은 PreorderForm 클라이언트 컴포넌트로 분리. */
import PreorderForm from './components/PreorderForm';

const env = {
  ideaName: process.env.NEXT_PUBLIC_IDEA_NAME || '아이디어',
  tagline: process.env.NEXT_PUBLIC_IDEA_TAGLINE || '',
  valueProp: process.env.NEXT_PUBLIC_IDEA_VALUE_PROP || '',
  target: process.env.NEXT_PUBLIC_TARGET_AUDIENCE || '',
  preorderPrice: process.env.NEXT_PUBLIC_PREORDER_PRICE || '4900',
  regularPrice: process.env.NEXT_PUBLIC_REGULAR_PRICE || '19900',
  quota: process.env.NEXT_PUBLIC_EARLYBIRD_QUOTA || '100',
  benefit: process.env.NEXT_PUBLIC_EARLYBIRD_BENEFIT || '',
  refund: process.env.NEXT_PUBLIC_REFUND_POLICY || '출시 안 되면 100% 환불',
};

const fmt = (s: string) => Number(s).toLocaleString('ko-KR');

export default function Home() {
  return (
    <main className="min-h-screen">
      <section className="max-w-3xl mx-auto px-6 py-16 sm:py-24">
        <span className="inline-block px-3 py-1 bg-brand/10 text-brand text-sm rounded-full mb-4 font-medium">
          ⚡ 얼리버드 {env.quota}명 한정
        </span>
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">{env.ideaName}</h1>
        {env.tagline && <p className="text-xl text-[var(--text-dim)] mb-2">{env.tagline}</p>}
        {env.target && <p className="text-sm text-[var(--text-dim)] mb-8">For. {env.target}</p>}

        {env.valueProp && (
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100 mb-8">
            <p className="text-lg leading-relaxed">{env.valueProp}</p>
          </div>
        )}

        <div className="bg-gradient-to-br from-brand to-brand-dark rounded-2xl p-8 text-white mb-8">
          <div className="flex items-baseline gap-3 mb-2">
            <span className="text-4xl font-bold">{fmt(env.preorderPrice)}원</span>
            <span className="text-lg line-through opacity-70">정가 {fmt(env.regularPrice)}원/월</span>
          </div>
          {env.benefit && <p className="text-sm opacity-90 mb-1">🎁 {env.benefit}</p>}
          <p className="text-xs opacity-75">💸 {env.refund}</p>
        </div>

        <PreorderForm />

        <p className="text-xs text-[var(--text-dim)] mt-8 text-center">
          폼 제출 후 송금 안내 페이지로 이동합니다. 송금 확인되면 이메일로 사전예약 완료를 알려드려요.
        </p>
      </section>
    </main>
  );
}
