'use client'

/* PostHog 클라이언트 초기화 + Provider.
   - NEXT_PUBLIC_POSTHOG_KEY 없으면 조용히 no-op (로컬/키 미설정 시 에러 X).
   - autocapture: 버튼/링크/폼 클릭을 코드 없이 자동 수집 → 수동 이벤트 배선 최소화.
   - capture_pageview/pageleave: 방문수·체류·이탈 자동 기록 (퍼널 1단계). */
import posthog from 'posthog-js' 
import { PostHogProvider } from 'posthog-js/react'
import { useEffect } from 'react'

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
    if (!key) return
    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: true,
      person_profiles: 'identified_only',
    })
  }, [])

  return <PostHogProvider client={posthog}>{children}</PostHogProvider>
}
