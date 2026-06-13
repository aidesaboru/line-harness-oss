import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import worker from './index.js';
import type { Env } from './index.js';

type WorkerModule = {
  fetch: (request: Request, env: Env['Bindings'], ctx: ExecutionContext) => Promise<Response>;
};

const workerApp = worker as WorkerModule;

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB: {} as D1Database,
    IMAGES: {} as R2Bucket,
    ASSETS: { fetch: vi.fn() } as unknown as Fetcher,
    LINE_CHANNEL_SECRET: 'line-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    API_KEY: 'api-key',
    LIFF_URL: 'https://liff.line.me/12345-main',
    LINE_CHANNEL_ID: 'line-channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://worker.example.com',
    ...overrides,
  };
}

function executionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

function request(path: string, overrides?: Partial<Env['Bindings']>) {
  return workerApp.fetch(
    new Request(`https://worker.example.com${path}`, {
      headers: { 'CF-Connecting-IP': '203.0.113.10' },
    }),
    env(overrides),
    executionContext(),
  );
}

function fetchMock() {
  return vi.fn(async () => new Response('png', {
    headers: { 'Content-Type': 'image/png' },
  }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('public QR proxy guard', () => {
  test('forwards valid URL data with a bounded default size', async () => {
    const data = 'https://liff.line.me/12345-main?ref=abc&form=form-1';
    const res = await request(`/api/qr?data=${encodeURIComponent(data)}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');

    const upstream = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    expect(upstream.origin).toBe('https://api.qrserver.com');
    expect(upstream.searchParams.get('size')).toBe('240x240');
    expect(upstream.searchParams.get('data')).toBe(data);
  });

  test('accepts square sizes only within the public proxy limit', async () => {
    const data = encodeURIComponent('https://liff.line.me/12345-main');
    const ok = await request(`/api/qr?size=512x512&data=${data}`);
    const rectangle = await request(`/api/qr?size=240x360&data=${data}`);
    const huge = await request(`/api/qr?size=2048x2048&data=${data}`);
    const malformed = await request(`/api/qr?size=large&data=${data}`);

    expect(ok.status).toBe(200);
    expect(rectangle.status).toBe(400);
    expect(huge.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  test('rejects missing, non-url, non-http, and oversized QR data before upstream fetch', async () => {
    const missing = await request('/api/qr');
    const plainText = await request('/api/qr?data=hello');
    const nonHttp = await request(`/api/qr?data=${encodeURIComponent('javascript:alert(1)')}`);
    const oversized = await request(`/api/qr?data=${encodeURIComponent(`https://example.com/${'a'.repeat(2048)}`)}`);

    expect(missing.status).toBe(400);
    expect(plainText.status).toBe(400);
    expect(nonHttp.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  test('does not relay non-image upstream responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', {
      headers: { 'Content-Type': 'text/plain' },
    })));

    const data = encodeURIComponent('https://liff.line.me/12345-main');
    const res = await request(`/api/qr?data=${data}`);

    expect(res.status).toBe(502);
  });
});

describe('public short link guard', () => {
  test('rejects unsafe short-link path and query values before DB lookup or QR fetch', async () => {
    const prepare = vi.fn(() => {
      throw new Error('DB should not be called');
    });
    const db = { prepare } as unknown as D1Database;
    const paths = [
      '/r/bad%20ref',
      `/r/${'a'.repeat(513)}`,
      '/r/launch?form=bad%20form',
      '/r/launch?pool=Bad',
      '/r/launch?gate=bad%20gate',
      '/r/launch?xh=bad%20xh',
      '/r/launch?ig=bad%20ig',
      '/r/bad%20ref/help',
      `/r/launch/help?t=${encodeURIComponent(`https://liff.line.me/${'a'.repeat(2050)}`)}`,
    ];

    for (const path of paths) {
      const res = await request(path, { DB: db });
      expect(res.status, path).toBe(400);
      expect(prepare, path).not.toHaveBeenCalled();
      expect(vi.mocked(fetch), path).not.toHaveBeenCalled();
    }
  });

  test('trims valid short-link values before DB lookup and LIFF URL rendering', async () => {
    const first = vi.fn().mockResolvedValue(null);
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const db = { prepare } as unknown as D1Database;

    const res = await request(
      '/r/%20launch%20?pool=%20main%20&form=%20form-1%20&gate=%20gate-1%20&xh=%20xh-1%20&ig=%20ig-1%20',
      { DB: db },
    );

    expect(res.status).toBe(200);
    expect(bind.mock.calls).toEqual([['launch'], ['main']]);
    const body = await res.text();
    expect(body).toContain('ref%3Dlaunch');
    expect(body).toContain('form%3Dform-1');
    expect(body).toContain('gate%3Dgate-1');
    expect(body).toContain('xh%3Dxh-1');
    expect(body).toContain('ig%3Dig-1');
  });

  test('short-link help ignores unsafe t fallback and only preserves validated retry params', async () => {
    const res = await request('/r/%20launch%20/help?t=https%3A%2F%2Fevil.example%2Fopen&form=%20form-1%20&pool=%20main%20&extra=bad');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('evil.example');
    expect(body).not.toContain('extra=bad');
    expect(body).toContain('/r/launch?form=form-1&amp;pool=main');
  });
});
