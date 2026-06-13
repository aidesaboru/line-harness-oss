import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getStripeEvents: vi.fn(),
  getStripeEventByStripeId: vi.fn(),
  createStripeEvent: vi.fn(),
  jstNow: vi.fn(() => '2026-06-13T10:00:00.000'),
  getAdPlatforms: vi.fn(),
  getAdPlatformById: vi.fn(),
  createAdPlatform: vi.fn(),
  updateAdPlatform: vi.fn(),
  deleteAdPlatform: vi.fn(),
  getAdConversionLogs: vi.fn(),
  getAdPlatformByName: vi.fn(),
  getAffiliates: vi.fn(),
  getAffiliateById: vi.fn(),
  getAffiliateByCode: vi.fn(),
  createAffiliate: vi.fn(),
  updateAffiliate: vi.fn(),
  deleteAffiliate: vi.fn(),
  recordAffiliateClick: vi.fn(),
  getAffiliateReport: vi.fn(),
  getTrackedLinks: vi.fn(),
  getTrackedLinkById: vi.fn(),
  createTrackedLink: vi.fn(),
  updateTrackedLink: vi.fn(),
  deleteTrackedLink: vi.fn(),
  recordLinkClick: vi.fn(),
  getLinkClicks: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  addTagToFriend: vi.fn(),
  enrollFriendInScenario: vi.fn(),
};

vi.mock('@line-crm/db', () => dbMocks);
vi.mock('../services/ad-conversion.js', () => ({
  sendAdConversions: vi.fn(),
}));

const { stripe } = await import('./stripe.js');
const { adPlatforms } = await import('./ad-platforms.js');
const { affiliates } = await import('./affiliates.js');
const { trackedLinks } = await import('./tracked-links.js');

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database; WORKER_URL: string; LIFF_URL: string };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

function setupApp(role: StaffRole = 'staff') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Tajima', role });
    c.env = {
      DB: {} as D1Database,
      WORKER_URL: 'https://worker.example.com',
      LIFF_URL: 'https://liff.example.com',
    };
    await next();
  });
  app.route('/', stripe);
  app.route('/', adPlatforms);
  app.route('/', affiliates);
  app.route('/', trackedLinks);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getStripeEvents.mockResolvedValue([]);
  dbMocks.getAdPlatforms.mockResolvedValue([
    {
      id: 'platform-1',
      name: 'meta',
      display_name: 'Meta',
      config: JSON.stringify({ accessToken: 'abcd1234secret5678' }),
      is_active: 1,
      created_at: '2026-06-13T10:00:00.000',
      updated_at: '2026-06-13T10:00:00.000',
    },
  ]);
  dbMocks.getAffiliateByCode.mockResolvedValue({
    id: 'affiliate-1',
    name: 'Partner',
    code: 'partner',
    commission_rate: 0.1,
    is_active: 1,
    created_at: '2026-06-13T10:00:00.000',
  });
  dbMocks.recordAffiliateClick.mockResolvedValue(undefined);
});

describe('operations API role guards', () => {
  test('staff cannot access revenue, ad, affiliate, or tracked-link management APIs', async () => {
    const app = setupApp('staff');

    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/integrations/stripe/events'],
      ['GET', '/api/ad-platforms'],
      ['POST', '/api/ad-platforms', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'meta', config: { accessToken: 'secret' } }),
      }],
      ['PUT', '/api/ad-platforms/platform-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      }],
      ['POST', '/api/ad-platforms/test', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'meta', eventName: 'purchase' }),
      }],
      ['DELETE', '/api/ad-platforms/platform-1'],
      ['GET', '/api/ad-platforms/platform-1/logs'],
      ['GET', '/api/affiliates'],
      ['GET', '/api/affiliates/affiliate-1'],
      ['POST', '/api/affiliates', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Partner', code: 'partner' }),
      }],
      ['PUT', '/api/affiliates/affiliate-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      }],
      ['DELETE', '/api/affiliates/affiliate-1'],
      ['GET', '/api/affiliates/affiliate-1/report'],
      ['GET', '/api/affiliates-report'],
      ['GET', '/api/tracked-links'],
      ['GET', '/api/tracked-links/link-1'],
      ['POST', '/api/tracked-links', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'LP', originalUrl: 'https://example.com' }),
      }],
      ['PATCH', '/api/tracked-links/link-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      }],
      ['DELETE', '/api/tracked-links/link-1'],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(dbMocks.getStripeEvents).not.toHaveBeenCalled();
    expect(dbMocks.getAdPlatforms).not.toHaveBeenCalled();
    expect(dbMocks.createAdPlatform).not.toHaveBeenCalled();
    expect(dbMocks.updateAdPlatform).not.toHaveBeenCalled();
    expect(dbMocks.deleteAdPlatform).not.toHaveBeenCalled();
    expect(dbMocks.getAdConversionLogs).not.toHaveBeenCalled();
    expect(dbMocks.getAffiliates).not.toHaveBeenCalled();
    expect(dbMocks.getAffiliateById).not.toHaveBeenCalled();
    expect(dbMocks.createAffiliate).not.toHaveBeenCalled();
    expect(dbMocks.updateAffiliate).not.toHaveBeenCalled();
    expect(dbMocks.deleteAffiliate).not.toHaveBeenCalled();
    expect(dbMocks.getAffiliateReport).not.toHaveBeenCalled();
    expect(dbMocks.getTrackedLinks).not.toHaveBeenCalled();
    expect(dbMocks.getTrackedLinkById).not.toHaveBeenCalled();
    expect(dbMocks.createTrackedLink).not.toHaveBeenCalled();
    expect(dbMocks.updateTrackedLink).not.toHaveBeenCalled();
    expect(dbMocks.deleteTrackedLink).not.toHaveBeenCalled();
  });

  test('owner can read masked ad platform configuration', async () => {
    const res = await setupApp('owner').request('/api/ad-platforms');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; config: Record<string, unknown> }> };
    expect(body.data).toEqual([
      {
        id: 'platform-1',
        name: 'meta',
        displayName: 'Meta',
        config: { accessToken: 'abcd****5678' },
        isActive: true,
        createdAt: '2026-06-13T10:00:00.000',
        updatedAt: '2026-06-13T10:00:00.000',
      },
    ]);
  });

  test('owner Stripe events clamp invalid and fractional limit query values', async () => {
    const app = setupApp('owner');

    expect((await app.request('/api/integrations/stripe/events?limit=abc')).status).toBe(200);
    expect((await app.request('/api/integrations/stripe/events?limit=2.9')).status).toBe(200);
    expect((await app.request('/api/integrations/stripe/events?limit=9999')).status).toBe(200);

    expect(dbMocks.getStripeEvents).toHaveBeenNthCalledWith(1, {} as D1Database, {
      friendId: undefined,
      eventType: undefined,
      limit: 100,
    });
    expect(dbMocks.getStripeEvents).toHaveBeenNthCalledWith(2, {} as D1Database, {
      friendId: undefined,
      eventType: undefined,
      limit: 2,
    });
    expect(dbMocks.getStripeEvents).toHaveBeenNthCalledWith(3, {} as D1Database, {
      friendId: undefined,
      eventType: undefined,
      limit: 500,
    });
  });

  test('owner ad conversion logs clamp invalid and oversized limit query values', async () => {
    dbMocks.getAdConversionLogs.mockResolvedValue([]);
    const app = setupApp('owner');

    expect((await app.request('/api/ad-platforms/platform-1/logs?limit=Infinity')).status).toBe(200);
    expect((await app.request('/api/ad-platforms/platform-1/logs?limit=0')).status).toBe(200);
    expect((await app.request('/api/ad-platforms/platform-1/logs?limit=9999')).status).toBe(200);

    expect(dbMocks.getAdConversionLogs).toHaveBeenNthCalledWith(1, {} as D1Database, 'platform-1', 50);
    expect(dbMocks.getAdConversionLogs).toHaveBeenNthCalledWith(2, {} as D1Database, 'platform-1', 1);
    expect(dbMocks.getAdConversionLogs).toHaveBeenNthCalledWith(3, {} as D1Database, 'platform-1', 500);
  });

  test('public affiliate click endpoint remains unguarded', async () => {
    const res = await setupApp('staff').request('/api/affiliates/click', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.10',
      },
      body: JSON.stringify({ code: 'partner', url: 'https://example.com/lp' }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.getAffiliateByCode).toHaveBeenCalledWith({} as D1Database, 'partner');
    expect(dbMocks.recordAffiliateClick).toHaveBeenCalledWith(
      {} as D1Database,
      'affiliate-1',
      'https://example.com/lp',
      '203.0.113.10',
    );
  });

  test('public affiliate click rejects malformed or oversized payloads before affiliate lookup', async () => {
    const app = setupApp('staff');

    const malformed = await app.request('/api/affiliates/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    const oversizedCode = await app.request('/api/affiliates/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'p'.repeat(129), url: 'https://example.com/lp' }),
    });
    const unsafeUrl = await app.request('/api/affiliates/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'partner', url: 'javascript:alert(1)' }),
    });
    const oversizedUrl = await app.request('/api/affiliates/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'partner', url: `https://example.com/${'a'.repeat(2048)}` }),
    });

    expect(malformed.status).toBe(400);
    expect(oversizedCode.status).toBe(400);
    expect(unsafeUrl.status).toBe(400);
    expect(oversizedUrl.status).toBe(400);
    expect(dbMocks.getAffiliateByCode).not.toHaveBeenCalled();
    expect(dbMocks.recordAffiliateClick).not.toHaveBeenCalled();
  });

  test('public tracked-link redirect endpoint remains unguarded but ignores self-claimed friend identifiers', async () => {
    dbMocks.getTrackedLinkById.mockResolvedValue({
      id: 'link-1',
      name: 'LP',
      original_url: 'https://example.com/lp',
      tag_id: 'tag-1',
      scenario_id: 'scenario-1',
      intro_template_id: null,
      reward_template_id: null,
      is_active: 1,
      click_count: 0,
      created_at: '2026-06-13T10:00:00.000',
      updated_at: '2026-06-13T10:00:00.000',
    });
    dbMocks.recordLinkClick.mockResolvedValue(undefined);
    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
    const executionCtx = {
      waitUntil,
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const res = await setupApp('staff').request(
      '/t/link-1?f=friend-1&lu=U-victim',
      { method: 'GET' },
      {} as TestEnv['Bindings'],
      executionCtx,
    );
    await waitUntil.mock.calls[0]?.[0];

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/lp');
    expect(dbMocks.getTrackedLinkById).toHaveBeenCalledWith({} as D1Database, 'link-1');
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalled();
    expect(dbMocks.recordLinkClick).toHaveBeenCalledWith({} as D1Database, 'link-1', null);
    expect(dbMocks.addTagToFriend).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
  });

  test('LINE in-app tracked-link redirects to LIFF with ref for verified attribution', async () => {
    dbMocks.getTrackedLinkById.mockResolvedValue({
      id: 'link-1',
      name: 'LP',
      original_url: 'https://example.com/lp',
      tag_id: 'tag-1',
      scenario_id: 'scenario-1',
      intro_template_id: null,
      reward_template_id: null,
      is_active: 1,
      click_count: 0,
      created_at: '2026-06-13T10:00:00.000',
      updated_at: '2026-06-13T10:00:00.000',
    });
    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
    const executionCtx = {
      waitUntil,
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const res = await setupApp('staff').request(
      '/t/link-1',
      { method: 'GET', headers: { 'user-agent': 'Line/13.0' } },
      {} as TestEnv['Bindings'],
      executionCtx,
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe('https://liff.example.com/');
    expect(location.searchParams.get('ref')).toBe('link-1');
    expect(location.searchParams.get('redirect')).toBe('https://worker.example.com/t/link-1?lh_liff=1');
    expect(waitUntil).not.toHaveBeenCalled();
    expect(dbMocks.recordLinkClick).not.toHaveBeenCalled();
    expect(dbMocks.addTagToFriend).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
  });

  test('tracked-link return from verified LIFF skips duplicate anonymous click recording', async () => {
    dbMocks.getTrackedLinkById.mockResolvedValue({
      id: 'link-1',
      name: 'LP',
      original_url: 'https://example.com/lp',
      tag_id: null,
      scenario_id: null,
      intro_template_id: null,
      reward_template_id: null,
      is_active: 1,
      click_count: 0,
      created_at: '2026-06-13T10:00:00.000',
      updated_at: '2026-06-13T10:00:00.000',
    });
    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
    const executionCtx = {
      waitUntil,
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const res = await setupApp('staff').request(
      '/t/link-1?lh_liff=1',
      { method: 'GET' },
      {} as TestEnv['Bindings'],
      executionCtx,
    );
    await waitUntil.mock.calls[0]?.[0];

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/lp');
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(dbMocks.recordLinkClick).not.toHaveBeenCalled();
  });
});
