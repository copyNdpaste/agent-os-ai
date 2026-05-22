/**
 * 시스템 통합 헬퍼 — semver 비교, HTTP body drain, bridge probe, OS 파일 열기.
 *
 * extension.ts 에서 분리됨.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import axios from 'axios';
import { spawn } from 'child_process';

export const MAX_HTTP_BODY = 5 * 1024 * 1024;
export const CONNECT_AI_VERSION = '2.89.156';

/** semver-ish 비교 — a < b 이면 true (a 가 옛 버전). */
export function versionLessThan(a: string, b: string): boolean {
    const pa = a.split('.').map(n => parseInt(n, 10) || 0);
    const pb = b.split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const ai = pa[i] || 0, bi = pb[i] || 0;
        if (ai !== bi) return ai < bi;
    }
    return false;
}

/**
 * 포트 4825 에 떠있는 Bridge 가 우리 것인지 식별.
 *  - ours: connect-ai-bridge 식별자
 *  - version: 그 인스턴스 버전
 *  - pid: 종료 대상 PID
 */
export async function probeExistingBridge(): Promise<{ ours: boolean; version: string; pid: number }> {
    try {
        const r = await axios.get('http://127.0.0.1:4825/ping', { timeout: 1500 });
        const d = r.data;
        if (d && d.app === 'connect-ai-bridge') {
            return { ours: true, version: String(d.version || ''), pid: Number(d.pid || 0) };
        }
    } catch { /* not running or different app */ }
    return { ours: false, version: '', pid: 0 };
}

/**
 * Drain an http request body with a hard size cap.
 * BODY_TOO_LARGE 에러로 reject 가능.
 */
export function readRequestBody(req: http.IncomingMessage, maxBytes = MAX_HTTP_BODY): Promise<string> {
    return new Promise((resolve, reject) => {
        let received = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxBytes) {
                reject(new Error('BODY_TOO_LARGE'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

/** OS 파일 익스플로러로 파일/폴더 열기 (Finder · Windows Explorer · xdg-open). */
export function revealInOsExplorer(targetPath: string): { ok: boolean; message: string } {
    try {
        if (!fs.existsSync(targetPath)) {
            return { ok: false, message: `존재하지 않는 경로: ${targetPath}` };
        }
        if (process.platform === 'darwin') {
            spawn('open', ['-R', targetPath], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'win32') {
            spawn('explorer.exe', ['/select,', targetPath], { detached: true, stdio: 'ignore' }).unref();
        } else {
            const dir = fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
            spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
        }
        return { ok: true, message: `🗂 익스플로러 열림: ${targetPath}` };
    } catch (e: any) {
        return { ok: false, message: `익스플로러 열기 실패: ${e?.message || e}` };
    }
}

/** 기본 앱으로 파일 열기 (이미지·PDF·웹페이지·.docx 등). */
export function openInDefaultApp(targetPath: string): { ok: boolean; message: string } {
    try {
        if (!fs.existsSync(targetPath)) {
            return { ok: false, message: `존재하지 않는 경로: ${targetPath}` };
        }
        if (process.platform === 'darwin') {
            spawn('open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'win32') {
            spawn('cmd.exe', ['/c', 'start', '', targetPath], { detached: true, stdio: 'ignore' }).unref();
        } else {
            spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' }).unref();
        }
        return { ok: true, message: `🚀 기본 앱으로 열림: ${targetPath}` };
    } catch (e: any) {
        return { ok: false, message: `파일 열기 실패: ${e?.message || e}` };
    }
}
