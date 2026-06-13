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
  Bindings: { DB: D1Database; WORKER_URL: string; LIFF_URL: string; STRIPE_WEBHOOK_SECRET?: string };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

function setupApp(role: StaffRole = 'staff', envOverrides: Partial<TestEnv['Bindings']> = {}) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Tajima', role });
    c.env = {
      DB: {} as D1Database,
      WORKER_URL: 'https://worker.example.com',
      LIFF_URL: 'https://liff.example.com',
      ...envOverrides,
    };
    await next();
  });
  app.route('/', stripe);
  app.route('/', adPlatforms);
  app.route('/', affiliates);
  app.route('/', trackedLinks);
  return app;
}

async function stripeSignature(secret: string, rawBody: string, timestamp = 1_812_345_678): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `t=${timestamp},v1=${hex}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getStripeEvents.mockResolvedValue([]);
  dbMocks.getStripeEventByStripeId.mockResolvedValue(null);
  dbMocks.createStripeEvent.mockResolvedValue({
    id: 'stripe-row-1',
    stripe_event_id: 'evt_1',
    event_type: 'charge.succeeded',
    friend_id: 'friend-1',
    amount: 1200,
    currency: 'jpy',
    metadata: JSON.stringify({ line_friend_id: 'friend-1' }),
    processed_at: '2026-06-13T10:00:00.000',
  });
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
  dbMocks.createAdPlatform.mockResolvedValue({
    id: 'platform-new',
    name: 'meta',
    display_name: 'Meta Ads',
    config: JSON.stringify({ access_token: 'secret', priority: 1, enabled: true }),
    is_active: 1,
    created_at: '2026-06-13T10:00:00.000',
    updated_at: '2026-06-13T10:00:00.000',
  });
  dbMocks.updateAdPlatform.mockResolvedValue({
    id: 'platform-1',
    name: 'meta',
    display_name: null,
    config: JSON.stringify({ pixel_id: 'px-1' }),
    is_active: 0,
    created_at: '2026-06-13T10:00:00.000',
    updated_at: '2026-06-13T10:00:00.000',
  });
  dbMocks.getAffiliateByCode.mockResolvedValue({
    id: 'affiliate-1',
    name: 'Partner',
    code: 'partner',
    commission_rate: 0.1,
    is_active: 1,
    created_at: '2026-06-13T10:00:00.000',
  });
  dbMocks.createAffiliate.mockResolvedValue({
    id: 'affiliate-new',
    name: 'Partner',
    code: 'partner-1',
    commission_rate: 0.25,
    is_active: 1,
    created_at: '2026-06-13T10:00:00.000',
  });
  dbMocks.updateAffiliate.mockResolvedValue({
    id: 'affiliate-1',
    name: 'Partner New',
    code: 'partner',
    commission_rate: 0.2,
    is_active: 0,
    created_at: '2026-06-13T10:00:00.000',
  });
  dbMocks.recordAffiliateClick.mockResolvedValue(undefined);
  dbMocks.createTrackedLink.mockResolvedValue({
    id: 'link-new',
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
  dbMocks.updateTrackedLink.mockResolvedValue({
    id: 'link-1',
    name: 'LP New',
    original_url: 'https://example.com/lp',
    tag_id: null,
    scenario_id: null,
    intro_template_id: null,
    reward_template_id: null,
    is_active: 0,
    click_count: 0,
    created_at: '2026-06-13T10:00:00.000',
    updated_at: '2026-06-13T10:00:00.000',
  });
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

  test('owner Stripe events reject unsafe filter query values before DB helper calls', async () => {
    const app = setupApp('owner');
    const queries = [
      'friendId=bad%20friend',
      'eventType=charge%20succeeded',
    ];

    for (const query of queries) {
      const res = await app.request(`/api/integrations/stripe/events?${query}`);

      expect(res.status, query).toBe(400);
      expect(dbMocks.getStripeEvents, query).not.toHaveBeenCalled();
    }
  });

  test('owner Stripe events trim valid filter query values before DB helper calls', async () => {
    const res = await setupApp('owner')
      .request('/api/integrations/stripe/events?friendId=%20friend-1%20&eventType=%20charge.succeeded%20&limit=2.9');

    expect(res.status).toBe(200);
    expect(dbMocks.getStripeEvents).toHaveBeenCalledWith({} as D1Database, {
      friendId: 'friend-1',
      eventType: 'charge.succeeded',
      limit: 2,
    });
  });

  test('owner affiliate reports reject unsafe id and date filters before DB helper calls', async () => {
    const app = setupApp('owner');
    const paths = [
      '/api/affiliates/bad%20affiliate/report',
      '/api/affiliates/affiliate-1/report?startDate=not-a-date',
      '/api/affiliates/affiliate-1/report?startDate=2026-06-30&endDate=2026-06-01',
      '/api/affiliates-report?endDate=bad%20date',
    ];

    for (const path of paths) {
      const res = await app.request(path);

      expect(res.status, path).toBe(400);
      expect(dbMocks.getAffiliateReport, path).not.toHaveBeenCalled();
    }
  });

  test('owner affiliate reports trim valid id and date filters before DB helper calls', async () => {
    dbMocks.getAffiliateReport.mockResolvedValue([
      {
        affiliateId: 'affiliate-1',
        affiliateName: 'Partner',
        code: 'partner',
        commissionRate: 0.1,
        totalClicks: 1,
        totalConversions: 1,
        totalRevenue: 1200,
      },
    ]);

    const detail = await setupApp('owner')
      .request('/api/affiliates/%20affiliate-1%20/report?startDate=%202026-06-01%20&endDate=%202026-06-30%20');
    const summary = await setupApp('owner')
      .request('/api/affiliates-report?startDate=%202026-06-01%20&endDate=%202026-06-30%20');

    expect(detail.status).toBe(200);
    expect(summary.status).toBe(200);
    expect(dbMocks.getAffiliateReport).toHaveBeenNthCalledWith(1, {} as D1Database, 'affiliate-1', {
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });
    expect(dbMocks.getAffiliateReport).toHaveBeenNthCalledWith(2, {} as D1Database, undefined, {
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });
  });

  test('public Stripe webhook accepts valid signed bounded payloads', async () => {
    const secret = 'whsec_test_secret';
    const rawBody = JSON.stringify({
      id: 'evt_1',
      type: 'charge.succeeded',
      data: {
        object: {
          id: 'ch_1',
          amount: 1200,
          currency: 'jpy',
          metadata: { line_friend_id: 'friend-1' },
        },
      },
    });
    const res = await setupApp('staff', { STRIPE_WEBHOOK_SECRET: secret }).request('/api/integrations/stripe/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': await stripeSignature(secret, rawBody),
      },
      body: rawBody,
    });

    expect(res.status).toBe(200);
    expect(dbMocks.getStripeEventByStripeId).toHaveBeenCalledWith({} as D1Database, 'evt_1');
    expect(dbMocks.createStripeEvent).toHaveBeenCalledWith({} as D1Database, {
      stripeEventId: 'evt_1',
      eventType: 'charge.succeeded',
      friendId: 'friend-1',
      amount: 1200,
      currency: 'jpy',
      metadata: JSON.stringify({ line_friend_id: 'friend-1' }),
    });
  });

  test('public Stripe webhook rejects malformed signed payloads before DB writes', async () => {
    const secret = 'whsec_test_secret';
    const rawBody = '{not-json';
    const res = await setupApp('staff', { STRIPE_WEBHOOK_SECRET: secret }).request('/api/integrations/stripe/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': await stripeSignature(secret, rawBody),
      },
      body: rawBody,
    });

    expect(res.status).toBe(400);
    expect(dbMocks.getStripeEventByStripeId).not.toHaveBeenCalled();
    expect(dbMocks.createStripeEvent).not.toHaveBeenCalled();
  });

  test('public Stripe webhook rejects oversized payloads before DB writes', async () => {
    const res = await setupApp('staff', { STRIPE_WEBHOOK_SECRET: 'whsec_test_secret' }).request('/api/integrations/stripe/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(1024 * 1024 + 1),
        'Stripe-Signature': 't=1812345678,v1=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: '{}',
    });

    expect(res.status).toBe(413);
    expect(dbMocks.getStripeEventByStripeId).not.toHaveBeenCalled();
    expect(dbMocks.createStripeEvent).not.toHaveBeenCalled();
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

  test('owner ad platform management rejects malformed or invalid payloads before writes', async () => {
    const app = setupApp('owner');

    const malformed = await app.request('/api/ad-platforms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    const invalidName = await app.request('/api/ad-platforms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'linkedin', config: { access_token: 'secret' } }),
    });
    const invalidConfigShape = await app.request('/api/ad-platforms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'meta', config: ['secret'] }),
    });
    const invalidConfigKey = await app.request('/api/ad-platforms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'meta', config: { 'bad key': 'secret' } }),
    });
    const invalidConfigValue = await app.request('/api/ad-platforms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'meta', config: { access_token: { nested: 'secret' } } }),
    });
    const invalidUpdate = await app.request('/api/ad-platforms/platform-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: 'false' }),
    });

    expect(malformed.status).toBe(400);
    expect(invalidName.status).toBe(400);
    expect(invalidConfigShape.status).toBe(400);
    expect(invalidConfigKey.status).toBe(400);
    expect(invalidConfigValue.status).toBe(400);
    expect(invalidUpdate.status).toBe(400);
    expect(dbMocks.createAdPlatform).not.toHaveBeenCalled();
    expect(dbMocks.updateAdPlatform).not.toHaveBeenCalled();
  });

  test('owner ad platform management trims and normalizes valid payloads before writes', async () => {
    const app = setupApp('owner');

    const created = await app.request('/api/ad-platforms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ' meta ',
        displayName: ' Meta Ads ',
        config: { access_token: 'secret', priority: 1, enabled: true },
      }),
    });
    const updated = await app.request('/api/ad-platforms/platform-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: ' ', config: { pixel_id: 'px-1' }, isActive: false }),
    });

    expect(created.status).toBe(201);
    expect(updated.status).toBe(200);
    expect(dbMocks.createAdPlatform).toHaveBeenCalledWith({} as D1Database, {
      name: 'meta',
      displayName: 'Meta Ads',
      config: { access_token: 'secret', priority: 1, enabled: true },
    });
    expect(dbMocks.updateAdPlatform).toHaveBeenCalledWith({} as D1Database, 'platform-1', {
      name: undefined,
      displayName: null,
      config: { pixel_id: 'px-1' },
      isActive: false,
    });
  });

  test('owner ad platform test send rejects invalid payloads before lookup', async () => {
    const app = setupApp('owner');

    const malformed = await app.request('/api/ad-platforms/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    const invalidPlatform = await app.request('/api/ad-platforms/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'linkedin', eventName: 'Purchase' }),
    });
    const invalidEventName = await app.request('/api/ad-platforms/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'meta', eventName: 'bad event' }),
    });
    const invalidFriendId = await app.request('/api/ad-platforms/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'meta', eventName: 'Purchase', friendId: 'f'.repeat(129) }),
    });

    expect(malformed.status).toBe(400);
    expect(invalidPlatform.status).toBe(400);
    expect(invalidEventName.status).toBe(400);
    expect(invalidFriendId.status).toBe(400);
    expect(dbMocks.getAdPlatformByName).not.toHaveBeenCalled();
  });

  test('owner affiliate management rejects malformed or invalid payloads before writes', async () => {
    const app = setupApp('owner');

    const malformed = await app.request('/api/affiliates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    const unsafeCode = await app.request('/api/affiliates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Partner', code: 'bad code' }),
    });
    const oversizedName = await app.request('/api/affiliates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'P'.repeat(121), code: 'partner' }),
    });
    const invalidRate = await app.request('/api/affiliates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Partner', code: 'partner', commissionRate: 1.5 }),
    });
    const invalidUpdate = await app.request('/api/affiliates/affiliate-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: 'yes' }),
    });

    expect(malformed.status).toBe(400);
    expect(unsafeCode.status).toBe(400);
    expect(oversizedName.status).toBe(400);
    expect(invalidRate.status).toBe(400);
    expect(invalidUpdate.status).toBe(400);
    expect(dbMocks.createAffiliate).not.toHaveBeenCalled();
    expect(dbMocks.updateAffiliate).not.toHaveBeenCalled();
  });

  test('owner affiliate management trims valid payloads before writes', async () => {
    const app = setupApp('owner');

    const created = await app.request('/api/affiliates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ' Partner ', code: ' partner-1 ', commissionRate: 0.25 }),
    });
    const updated = await app.request('/api/affiliates/affiliate-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ' Partner New ', commissionRate: 0.2, isActive: false }),
    });

    expect(created.status).toBe(201);
    expect(updated.status).toBe(200);
    expect(dbMocks.createAffiliate).toHaveBeenCalledWith({} as D1Database, {
      name: 'Partner',
      code: 'partner-1',
      commissionRate: 0.25,
    });
    expect(dbMocks.updateAffiliate).toHaveBeenCalledWith({} as D1Database, 'affiliate-1', {
      name: 'Partner New',
      commission_rate: 0.2,
      is_active: 0,
    });
  });

  test('owner tracked-link management rejects malformed or invalid payloads before writes', async () => {
    const app = setupApp('owner');

    const malformed = await app.request('/api/tracked-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    const unsafeUrl = await app.request('/api/tracked-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'LP', originalUrl: 'javascript:alert(1)' }),
    });
    const oversizedUrl = await app.request('/api/tracked-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'LP', originalUrl: `https://example.com/${'a'.repeat(2048)}` }),
    });
    const invalidRef = await app.request('/api/tracked-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'LP', originalUrl: 'https://example.com/lp', tagId: 'bad id' }),
    });
    const invalidUpdate = await app.request('/api/tracked-links/link-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: 'no' }),
    });

    expect(malformed.status).toBe(400);
    expect(unsafeUrl.status).toBe(400);
    expect(oversizedUrl.status).toBe(400);
    expect(invalidRef.status).toBe(400);
    expect(invalidUpdate.status).toBe(400);
    expect(dbMocks.createTrackedLink).not.toHaveBeenCalled();
    expect(dbMocks.updateTrackedLink).not.toHaveBeenCalled();
  });

  test('owner tracked-link management trims and normalizes valid payloads before writes', async () => {
    const app = setupApp('owner');

    const created = await app.request('/api/tracked-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ' LP ',
        originalUrl: ' https://example.com/lp ',
        tagId: '',
        scenarioId: 'scenario-1',
        introTemplateId: null,
        rewardTemplateId: 'reward_1',
      }),
    });
    const updated = await app.request('/api/tracked-links/link-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ' LP New ', tagId: null, isActive: false }),
    });

    expect(created.status).toBe(201);
    expect(updated.status).toBe(200);
    expect(dbMocks.createTrackedLink).toHaveBeenCalledWith({} as D1Database, {
      name: 'LP',
      originalUrl: 'https://example.com/lp',
      tagId: null,
      scenarioId: 'scenario-1',
      introTemplateId: null,
      rewardTemplateId: 'reward_1',
    });
    expect(dbMocks.updateTrackedLink).toHaveBeenCalledWith(
      {} as D1Database,
      'link-1',
      expect.objectContaining({
        name: 'LP New',
        tagId: null,
        isActive: false,
      }),
    );
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
    const unsafeCode = await app.request('/api/affiliates/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'bad code', url: 'https://example.com/lp' }),
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
    expect(unsafeCode.status).toBe(400);
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

  test('public tracked-link redirect rejects malformed link IDs before lookup or click recording', async () => {
    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
    const executionCtx = {
      waitUntil,
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;
    const app = setupApp('staff');

    const withSpace = await app.request(
      '/t/bad%20id',
      { method: 'GET' },
      {} as TestEnv['Bindings'],
      executionCtx,
    );
    const oversized = await app.request(
      `/t/${'l'.repeat(129)}`,
      { method: 'GET' },
      {} as TestEnv['Bindings'],
      executionCtx,
    );

    expect(withSpace.status).toBe(404);
    expect(oversized.status).toBe(404);
    expect(dbMocks.getTrackedLinkById).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(dbMocks.recordLinkClick).not.toHaveBeenCalled();
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
