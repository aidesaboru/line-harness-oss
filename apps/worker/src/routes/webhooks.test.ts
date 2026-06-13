import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@line-crm/db', () => ({
  getIncomingWebhooks: vi.fn(),
  getIncomingWebhookById: vi.fn(),
  createIncomingWebhook: vi.fn(),
  updateIncomingWebhook: vi.fn(),
  deleteIncomingWebhook: vi.fn(),
  getOutgoingWebhooks: vi.fn(),
  getOutgoingWebhookById: vi.fn(),
  createOutgoingWebhook: vi.fn(),
  updateOutgoingWebhook: vi.fn(),
  deleteOutgoingWebhook: vi.fn(),
}));

// Stub fireEvent to keep receive-endpoint tests focused on signature
// verification rather than the full event-bus + DB graph.
vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  getIncomingWebhooks,
  getIncomingWebhookById,
  createIncomingWebhook,
  updateIncomingWebhook,
  deleteIncomingWebhook,
  getOutgoingWebhooks,
  getOutgoingWebhookById,
  createOutgoingWebhook,
  updateOutgoingWebhook,
  deleteOutgoingWebhook,
} from '@line-crm/db';
import { webhooks } from './webhooks.js';

const VALID_SECRET = 'a'.repeat(32);
const SHORT_SECRET = 'a'.repeat(31);

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

function setupApp(role: StaffRole = 'owner') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Tajima', role });
    await next();
  });
  app.route('/', webhooks);
  return app;
}

const baseEnv = { DB: {} as D1Database } as TestEnv['Bindings'];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('webhook management role guards', () => {
  test('staff cannot manage webhook settings', async () => {
    const app = setupApp('staff');
    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/webhooks/incoming'],
      ['POST', '/api/webhooks/incoming', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'incoming', secret: VALID_SECRET }),
      }],
      ['PUT', '/api/webhooks/incoming/iwh-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed' }),
      }],
      ['DELETE', '/api/webhooks/incoming/iwh-1'],
      ['GET', '/api/webhooks/outgoing'],
      ['POST', '/api/webhooks/outgoing', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'outgoing', url: 'https://example.com/hook', secret: VALID_SECRET }),
      }],
      ['PUT', '/api/webhooks/outgoing/wh-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed' }),
      }],
      ['DELETE', '/api/webhooks/outgoing/wh-1'],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method }, baseEnv);
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(getIncomingWebhooks).not.toHaveBeenCalled();
    expect(createIncomingWebhook).not.toHaveBeenCalled();
    expect(updateIncomingWebhook).not.toHaveBeenCalled();
    expect(getOutgoingWebhooks).not.toHaveBeenCalled();
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('incoming receive endpoint stays public and signature-gated', async () => {
    vi.mocked(getIncomingWebhookById).mockResolvedValue({
      id: 'iwh-1',
      name: 'test',
      source_type: 'custom',
      secret: VALID_SECRET,
      is_active: 1,
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const res = await setupApp('staff').request(
      '/api/webhooks/incoming/iwh-1/receive',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ping: true }),
      },
      baseEnv,
    );

    expect(res.status).toBe(401);
    expect(getIncomingWebhookById).toHaveBeenCalledWith({} as D1Database, 'iwh-1');
  });
});

describe('webhook path ID validation', () => {
  test('rejects malformed management and receive IDs before DB helpers', async () => {
    const app = setupApp('owner');
    const requests: Array<[string, string, RequestInit?]> = [
      ['PUT', '/api/webhooks/incoming/bad%20id', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed' }),
      }],
      ['DELETE', '/api/webhooks/incoming/bad%20id'],
      ['PUT', '/api/webhooks/outgoing/bad%20id', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed' }),
      }],
      ['DELETE', '/api/webhooks/outgoing/bad%20id'],
      ['POST', '/api/webhooks/incoming/bad%20id/receive', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ping: true }),
      }],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method }, baseEnv);
      expect(res.status, `${method} ${path}`).toBe(400);
    }

    expect(getIncomingWebhookById).not.toHaveBeenCalled();
    expect(updateIncomingWebhook).not.toHaveBeenCalled();
    expect(deleteIncomingWebhook).not.toHaveBeenCalled();
    expect(getOutgoingWebhookById).not.toHaveBeenCalled();
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
    expect(deleteOutgoingWebhook).not.toHaveBeenCalled();
  });
});

// =====================================================
// POST /api/webhooks/outgoing — validation
// =====================================================

describe('POST /api/webhooks/outgoing — validation', () => {
  test('rejects malformed JSON before create', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/outgoing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not-json',
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('rejects missing secret with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/outgoing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', url: 'https://example.com/hook', eventTypes: ['*'] }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/secret/i);
  });

  test('rejects secret shorter than 32 chars with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/outgoing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test',
          url: 'https://example.com/hook',
          eventTypes: ['*'],
          secret: SHORT_SECRET,
        }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('rejects http:// URL with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/outgoing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test',
          url: 'http://example.com/hook',
          eventTypes: ['*'],
          secret: VALID_SECRET,
        }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('rejects malformed URL with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/outgoing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test',
          url: 'not-a-url',
          eventTypes: ['*'],
          secret: VALID_SECRET,
        }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('rejects malformed eventTypes before create', async () => {
    const app = setupApp();
    const badShape = await app.request(
      '/api/webhooks/outgoing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test',
          url: 'https://example.com/hook',
          eventTypes: 'not-an-array',
          secret: VALID_SECRET,
        }),
      },
      baseEnv,
    );
    const badNull = await app.request(
      '/api/webhooks/outgoing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test',
          url: 'https://example.com/hook',
          eventTypes: null,
          secret: VALID_SECRET,
        }),
      },
      baseEnv,
    );
    const badValue = await app.request(
      '/api/webhooks/outgoing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'test',
          url: 'https://example.com/hook',
          eventTypes: ['bad event'],
          secret: VALID_SECRET,
        }),
      },
      baseEnv,
    );

    expect(badShape.status).toBe(400);
    expect(badNull.status).toBe(400);
    expect(badValue.status).toBe(400);
    expect(createOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('accepts https:// + 32-char secret with 201, returns secret only on create', async () => {
    vi.mocked(createOutgoingWebhook).mockResolvedValue({
      id: 'wh-1',
      name: 'test',
      url: 'https://example.com/hook',
      event_types: '["*"]',
      secret: VALID_SECRET,
      is_active: 1,
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/outgoing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: ' test ',
          url: ' https://example.com/hook ',
          eventTypes: [' support.case.created '],
          secret: ` ${VALID_SECRET} `,
        }),
      },
      baseEnv,
    );
    expect(res.status).toBe(201);
    expect(createOutgoingWebhook).toHaveBeenCalledWith({} as D1Database, {
      name: 'test',
      url: 'https://example.com/hook',
      eventTypes: ['support.case.created'],
      secret: VALID_SECRET,
    });
    const body = (await res.json()) as {
      success: boolean;
      data: { id: string; secret: string; name: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.secret).toBe(VALID_SECRET);
    expect(body.data.id).toBe('wh-1');
  });
});

// =====================================================
// PUT /api/webhooks/outgoing/:id — validation
// =====================================================

describe('PUT /api/webhooks/outgoing/:id — validation', () => {
  test('rejects malformed JSON before update', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/outgoing/wh-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{not-json',
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
    expect(getOutgoingWebhookById).not.toHaveBeenCalled();
  });

  test('rejects updating to http:// URL with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/outgoing/wh-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://evil.example.com/' }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('rejects updating secret to fewer than 32 chars with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/outgoing/wh-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: SHORT_SECRET }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('rejects malformed eventTypes before update', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/outgoing/wh-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventTypes: [{}] }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
    expect(getOutgoingWebhookById).not.toHaveBeenCalled();
  });

  test('rejects truthy non-boolean isActive with 400 (migration bypass)', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/outgoing/wh-legacy',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: 1 }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
    expect(getOutgoingWebhookById).not.toHaveBeenCalled();
  });

  test('rejects re-activating webhook whose stored secret is too short (migration bypass)', async () => {
    vi.mocked(getOutgoingWebhookById).mockResolvedValue({
      id: 'wh-legacy',
      name: 'legacy',
      url: 'https://example.com/hook',
      event_types: '["*"]',
      secret: null,
      is_active: 0,
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/outgoing/wh-legacy',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: true }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('rejects re-activating webhook whose stored URL is http:// (migration bypass)', async () => {
    vi.mocked(getOutgoingWebhookById).mockResolvedValue({
      id: 'wh-legacy-http',
      name: 'legacy-http',
      url: 'http://example.com/hook',
      event_types: '["*"]',
      secret: VALID_SECRET,
      is_active: 0,
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/outgoing/wh-legacy-http',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: true }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateOutgoingWebhook).not.toHaveBeenCalled();
  });

  test('accepts partial update without secret/url change', async () => {
    vi.mocked(getOutgoingWebhookById).mockResolvedValue({
      id: 'wh-1',
      name: 'renamed',
      url: 'https://example.com/hook',
      event_types: '["*"]',
      secret: VALID_SECRET,
      is_active: 1,
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/outgoing/wh-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed' }),
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
    expect(updateOutgoingWebhook).toHaveBeenCalledOnce();
  });
});

// =====================================================
// GET /api/webhooks/outgoing — secret must NOT be exposed
// =====================================================

describe('GET /api/webhooks/outgoing — secret exposure', () => {
  test('does not include secret in response payload', async () => {
    vi.mocked(getOutgoingWebhooks).mockResolvedValue([
      {
        id: 'wh-1',
        name: 'test',
        url: 'https://example.com/hook',
        event_types: '["*"]',
        secret: VALID_SECRET,
        is_active: 1,
        created_at: '2026-05-08T00:00:00.000+09:00',
        updated_at: '2026-05-08T00:00:00.000+09:00',
      },
    ]);

    const app = setupApp();
    const res = await app.request('/api/webhooks/outgoing', { method: 'GET' }, baseEnv);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(VALID_SECRET);
    const body = JSON.parse(text) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).not.toHaveProperty('secret');
    // Caller should be told a secret IS configured, just not its value
    expect(body.data[0].hasSecret).toBe(true);
  });

  test('hasSecret is false when secret is null in DB', async () => {
    vi.mocked(getOutgoingWebhooks).mockResolvedValue([
      {
        id: 'wh-2',
        name: 'legacy',
        url: 'https://example.com/hook',
        event_types: '["*"]',
        secret: null,
        is_active: 0,
        created_at: '2026-05-08T00:00:00.000+09:00',
        updated_at: '2026-05-08T00:00:00.000+09:00',
      },
    ]);

    const app = setupApp();
    const res = await app.request('/api/webhooks/outgoing', { method: 'GET' }, baseEnv);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).not.toHaveProperty('secret');
    expect(body.data[0].hasSecret).toBe(false);
  });
});

// =====================================================
// POST /api/webhooks/incoming — validation
// =====================================================

describe('POST /api/webhooks/incoming — validation', () => {
  test('rejects malformed JSON before create', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/incoming',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not-json',
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createIncomingWebhook).not.toHaveBeenCalled();
  });

  test('rejects missing secret with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/incoming',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createIncomingWebhook).not.toHaveBeenCalled();
  });

  test('rejects secret shorter than 32 chars with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/incoming',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', secret: SHORT_SECRET }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createIncomingWebhook).not.toHaveBeenCalled();
  });

  test('rejects unsafe sourceType before create', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/incoming',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', sourceType: 'bad source', secret: VALID_SECRET }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(createIncomingWebhook).not.toHaveBeenCalled();
  });

  test('accepts 32-char secret with 201, returns secret on create only', async () => {
    vi.mocked(createIncomingWebhook).mockResolvedValue({
      id: 'iwh-1',
      name: 'test',
      source_type: 'custom',
      secret: VALID_SECRET,
      is_active: 1,
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/incoming',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: ' test ', sourceType: ' custom ', secret: ` ${VALID_SECRET} ` }),
      },
      baseEnv,
    );
    expect(res.status).toBe(201);
    expect(createIncomingWebhook).toHaveBeenCalledWith({} as D1Database, {
      name: 'test',
      sourceType: 'custom',
      secret: VALID_SECRET,
    });
    const body = (await res.json()) as { data: { id: string; secret: string } };
    expect(body.data.secret).toBe(VALID_SECRET);
  });
});

// =====================================================
// PUT /api/webhooks/incoming/:id — validation
// =====================================================

describe('PUT /api/webhooks/incoming/:id — validation', () => {
  test('rejects malformed JSON before update', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/incoming/iwh-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{not-json',
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateIncomingWebhook).not.toHaveBeenCalled();
    expect(getIncomingWebhookById).not.toHaveBeenCalled();
  });

  test('rejects updating secret to fewer than 32 chars with 400', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/incoming/iwh-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: SHORT_SECRET }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateIncomingWebhook).not.toHaveBeenCalled();
  });

  test('rejects unsafe sourceType before update', async () => {
    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/incoming/iwh-1',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceType: 'bad source' }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateIncomingWebhook).not.toHaveBeenCalled();
    expect(getIncomingWebhookById).not.toHaveBeenCalled();
  });

  test('rejects re-activating webhook whose stored secret is too short (migration bypass)', async () => {
    vi.mocked(getIncomingWebhookById).mockResolvedValue({
      id: 'iwh-legacy',
      name: 'legacy',
      source_type: 'custom',
      secret: null,
      is_active: 0,
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/incoming/iwh-legacy',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: true }),
      },
      baseEnv,
    );
    expect(res.status).toBe(400);
    expect(updateIncomingWebhook).not.toHaveBeenCalled();
  });
});

// =====================================================
// GET /api/webhooks/incoming — secret must NOT be exposed
// =====================================================

describe('GET /api/webhooks/incoming — secret exposure', () => {
  test('does not include secret in response payload', async () => {
    vi.mocked(getIncomingWebhooks).mockResolvedValue([
      {
        id: 'iwh-1',
        name: 'test',
        source_type: 'custom',
        secret: VALID_SECRET,
        is_active: 1,
        created_at: '2026-05-08T00:00:00.000+09:00',
        updated_at: '2026-05-08T00:00:00.000+09:00',
      },
    ]);

    const app = setupApp();
    const res = await app.request('/api/webhooks/incoming', { method: 'GET' }, baseEnv);
    const text = await res.text();
    expect(text).not.toContain(VALID_SECRET);
    const body = JSON.parse(text) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).not.toHaveProperty('secret');
    expect(body.data[0].hasSecret).toBe(true);
  });
});

// =====================================================
// POST /api/webhooks/incoming/:id/receive — signature verification
// =====================================================

describe('POST /api/webhooks/incoming/:id/receive — signature', () => {
  test('rejects request without X-Webhook-Signature with 401', async () => {
    vi.mocked(getIncomingWebhookById).mockResolvedValue({
      id: 'iwh-1',
      name: 'test',
      source_type: 'custom',
      secret: VALID_SECRET,
      is_active: 1,
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/incoming/iwh-1/receive',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ping: true }),
      },
      baseEnv,
    );
    expect(res.status).toBe(401);
  });

  test('rejects invalid signature with 401', async () => {
    vi.mocked(getIncomingWebhookById).mockResolvedValue({
      id: 'iwh-1',
      name: 'test',
      source_type: 'custom',
      secret: VALID_SECRET,
      is_active: 1,
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/incoming/iwh-1/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': 'deadbeef',
        },
        body: JSON.stringify({ ping: true }),
      },
      baseEnv,
    );
    expect(res.status).toBe(401);
  });

  test('accepts valid HMAC-SHA256 hex signature', async () => {
    vi.mocked(getIncomingWebhookById).mockResolvedValue({
      id: 'iwh-1',
      name: 'test',
      source_type: 'custom',
      secret: VALID_SECRET,
      is_active: 1,
      created_at: '2026-05-08T00:00:00.000+09:00',
      updated_at: '2026-05-08T00:00:00.000+09:00',
    });

    const body = JSON.stringify({ ping: true });
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(VALID_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const hexSignature = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const app = setupApp();
    const res = await app.request(
      '/api/webhooks/incoming/iwh-1/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': hexSignature,
        },
        body,
      },
      baseEnv,
    );
    expect(res.status).toBe(200);
  });
});
