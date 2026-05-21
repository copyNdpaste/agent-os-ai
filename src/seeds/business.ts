/**
 * Business 에이전트 도구 시드.
 *   - PayPal 매출 자동 분석 (sandbox / live)
 * v2.89.121 — PayPal Developer API 직결.
 */

import * as path from 'path';
import {
  _loadToolSeed,
  _seedFileForceUpgrade,
  _mergeSchemaIntoJson,
} from './common';

export function _seedBusinessPaypalRevenue(toolsDir: string) {
  const py = _loadToolSeed('business/paypal_revenue.py');
  const md = _loadToolSeed('business/paypal_revenue.md');
  const json = JSON.stringify({
    MODE: 'sandbox',
    CLIENT_ID: '',
    CLIENT_SECRET: '',
    LOOKBACK_DAYS: 30,
    CURRENCY: '',
    _schema: {
      MODE: {
        type: 'select',
        label: '🔧 모드',
        hint: '처음엔 sandbox (테스트 계정). 실제 매출 보려면 live.',
        options: [
          { value: 'sandbox', label: '🧪 Sandbox — 테스트 (가짜 계정·가짜 돈)' },
          { value: 'live',    label: '🚀 Live — 실제 운영 (진짜 돈)' },
        ],
      },
      CLIENT_ID: {
        type: 'text',
        label: '🔑 Client ID',
        hint: 'PayPal Developer Dashboard → Apps & Credentials 에서 발급',
      },
      CLIENT_SECRET: {
        type: 'password',
        label: '🔒 Client Secret',
        hint: '같은 곳에서 발급. 절대 외부 노출 금지 (도구 JSON은 .gitignore 적용됨)',
      },
      LOOKBACK_DAYS: {
        type: 'text',
        label: '📅 분석 기간 (일)',
        hint: '분석할 과거 일수. 30, 90, 365 등. 기본 30.',
      },
      CURRENCY: {
        type: 'text',
        label: '💱 기본 통화 (선택)',
        hint: 'USD / KRW / EUR 등. 비우면 모든 통화 표시.',
      },
    },
  }, null, 2);
  _seedFileForceUpgrade(path.join(toolsDir, 'paypal_revenue.py'), py, 'paypal_revenue_v3');
  _mergeSchemaIntoJson(path.join(toolsDir, 'paypal_revenue.json'), json);
  _seedFileForceUpgrade(path.join(toolsDir, 'paypal_revenue.md'), md, 'paypal_revenue_v1');
}
