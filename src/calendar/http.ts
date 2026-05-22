/**
 * Calendar HTTP client — Telegram client.ts 와 동일한 DI 패턴.
 *
 * axios 는 defaultHttpClient 안에서만 사용. 외부에는 HttpClient 인터페이스만
 * 노출해 테스트에서 fake (vi.fn) 주입이 가능. Google Calendar v3 + OAuth2
 * 호출용으로 get/post/patch/delete 4개 메서드를 모두 노출한다.
 *
 * 모든 메서드의 반환 shape 는 `{ status, data }` 로 통일 — axios 응답에서
 * 우리에게 필요한 두 필드만. opts.validateStatus = () => true 를 쓰면
 * non-2xx 응답에서도 throw 하지 않고 status 로 분기 가능 (Calendar 모듈은
 * 거의 항상 이렇게 호출).
 */
import axios from 'axios';

export interface HttpRequestOpts {
    headers?: Record<string, string>;
    timeout?: number;
    validateStatus?: (s: number) => boolean;
}

export interface HttpClient {
    get(url: string, opts?: HttpRequestOpts): Promise<{ status: number; data: any }>;
    post(url: string, data: any, opts?: HttpRequestOpts): Promise<{ status: number; data: any }>;
    patch(url: string, data: any, opts?: HttpRequestOpts): Promise<{ status: number; data: any }>;
    delete(url: string, opts?: HttpRequestOpts): Promise<{ status: number; data: any }>;
}

export const defaultHttpClient: HttpClient = {
    async get(url, opts) {
        const r = await axios.get(url, opts);
        return { status: r.status, data: r.data };
    },
    async post(url, data, opts) {
        const r = await axios.post(url, data, opts);
        return { status: r.status, data: r.data };
    },
    async patch(url, data, opts) {
        const r = await axios.patch(url, data, opts);
        return { status: r.status, data: r.data };
    },
    async delete(url, opts) {
        const r = await axios.delete(url, opts);
        return { status: r.status, data: r.data };
    },
};
