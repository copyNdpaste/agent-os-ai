import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  /* 빌드 시점에 안 깨지게 (env 없으면 런타임에서 명시적 에러). */
  console.warn('[supabase] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 미설정');
}

export const supabase = createClient(url || 'http://localhost', anonKey || 'anon-placeholder');
