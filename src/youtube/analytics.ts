/**
 * YouTube Analytics — 채널 28일 요약 (views / watch time / 트래픽 소스 / 국가).
 *
 * extension.ts 에서 byte-for-byte 복사 — fetchYouTubeAnalyticsSummary.
 *
 * Deps from extracted modules:
 *   - _ensureYtAccessToken           ← './oauth'
 */
import axios from 'axios';
import { _ensureYtAccessToken } from './oauth';

/* Pulls a 28-day Analytics summary for the user's channel — views,
   estimatedMinutesWatched, averageViewDuration, plus top traffic sources +
   top countries. Rolled into one object the dashboard renders. */
export async function fetchYouTubeAnalyticsSummary(): Promise<any> {
    const at = await _ensureYtAccessToken();
    if (!at) throw new Error('OAuth 토큰 없음');
    const end = new Date();
    const start = new Date(Date.now() - 28 * 86_400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const baseParams = {
        ids: 'channel==MINE',
        startDate: fmt(start),
        endDate: fmt(end),
    };
    const headers = { Authorization: `Bearer ${at}` };
    /* 1) totals */
    const totals = await axios.get('https://youtubeanalytics.googleapis.com/v2/reports', {
        params: { ...baseParams, metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained' },
        headers, timeout: 12000,
    });
    const row = totals.data?.rows?.[0] || [];
    const cols = (totals.data?.columnHeaders || []).map((c: any) => c.name);
    const get = (name: string) => { const i = cols.indexOf(name); return i >= 0 ? row[i] : null; };
    /* 2) top sources */
    let topSources: Array<{ source: string; views: number }> = [];
    try {
        const r = await axios.get('https://youtubeanalytics.googleapis.com/v2/reports', {
            params: { ...baseParams, metrics: 'views', dimensions: 'insightTrafficSourceType', sort: '-views', maxResults: 7 },
            headers, timeout: 12000,
        });
        topSources = (r.data?.rows || []).map((rr: any) => ({ source: String(rr[0]), views: Number(rr[1]) }));
    } catch { /* ignore */ }
    /* 3) top countries */
    let topCountries: Array<{ country: string; views: number }> = [];
    try {
        const r = await axios.get('https://youtubeanalytics.googleapis.com/v2/reports', {
            params: { ...baseParams, metrics: 'views', dimensions: 'country', sort: '-views', maxResults: 7 },
            headers, timeout: 12000,
        });
        topCountries = (r.data?.rows || []).map((rr: any) => ({ country: String(rr[0]), views: Number(rr[1]) }));
    } catch { /* ignore */ }
    return {
        views: get('views') || 0,
        estimatedMinutesWatched: get('estimatedMinutesWatched') || 0,
        avgViewDurationSec: get('averageViewDuration') || 0,
        avgViewPercentage: get('averageViewPercentage') || 0,
        subscribersGained: get('subscribersGained') || 0,
        topSources,
        topCountries,
    };
}
