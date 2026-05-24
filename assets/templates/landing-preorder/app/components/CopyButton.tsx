'use client';
/* 클립보드 복사 버튼 — 인터랙티브이므로 클라이언트 컴포넌트.
   RSC page 가 그냥 import 해서 쓰면 됨 (dynamic 불필요). */
import { useState } from 'react';

export default function CopyButton({ text, label = '복사' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch { /* ignore — 브라우저가 clipboard 허용 안 함 */ }
      }}
      className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-sm font-medium rounded-lg transition"
    >
      {done ? '✓ 복사됨' : label}
    </button>
  );
}
