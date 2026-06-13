import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const availabilityMocks = {
  computeSlots: vi.fn(),
  getAvailability: vi.fn(),
};

const dbMocks = {
  getLineAccounts: vi.fn(),
};

const idempotencyMocks = {
  findIdempotencyResponse: vi.fn(),
  saveIdempotencyResponse: vi.fn(),
};

vi.mock('../services/availability.js', () => availabilityMocks);
vi.mock('@line-crm/db', () => dbMocks);
vi.mock('../services/booking-idempotency.js', () => idempotencyMocks);

const { default: booking } = await import('./booking.js');

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database; LINE_LOGIN_CHANNEL_ID?: string };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

type DbCall = { sql: string; binds: unknown[] };

function makeDb() {
  const calls: DbCall[] = [];
  const db = {
    calls,
    prepare: vi.fn((sql: string) => {
      let bound: unknown[] = [];
      const stmt = {
        bind: vi.fn((...args: unknown[]) => {
          bound = args;
          calls.push({ sql, binds: args });
          return stmt;
        }),
        first: vi.fn(async <T>() => {
          if (sql.includes('FROM line_accounts')) {
            return (bound[0] === 'liff-1' ? { id: 'acc-1' } : null) as T | null;
          }
          if (sql.includes('FROM friends') && sql.includes('line_user_id')) {
            return (bound[0] === 'U-verified' && bound[1] === 'acc-1' ? { id: 'friend-1' } : null) as T | null;
          }
          if (sql.includes('SELECT is_following FROM friends')) {
            return { is_following: 1 } as T;
          }
          if (sql.includes('FROM menus m')) {
            return null as T | null;
          }
          return null as T | null;
        }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
      };
      return stmt;
    }),
  };
  return db as unknown as D1Database & { calls: DbCall[]; prepare: ReturnType<typeof vi.fn> };
}

function setupApp(db = makeDb()) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.env = { DB: db, LINE_LOGIN_CHANNEL_ID: 'login-channel' };
    await next();
  });
  app.route('/', booking);
  return { app, db };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  availabilityMocks.getAvailability.mockResolvedValue({ by_staff: [] });
  availabilityMocks.computeSlots.mockReturnValue([{ start: '10:00', end: '10:30' }]);
  dbMocks.getLineAccounts.mockResolvedValue([]);
  idempotencyMocks.findIdempotencyResponse.mockResolvedValue(null);
  idempotencyMocks.saveIdempotencyResponse.mockResolvedValue(undefined);
});

describe('public booking LIFF availability access', () => {
  test('rejects unsafe liffId before DB lookup or availability helper calls', async () => {
    const { app, db } = setupApp();

    const res = await app.request(
      '/api/liff/booking/availability?liffId=bad%20liff&menu_id=menu-1&from=2026-06-01&to=2026-06-02',
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_liff' });
    expect(db.prepare).not.toHaveBeenCalled();
    expect(availabilityMocks.getAvailability).not.toHaveBeenCalled();
  });

  test('rejects unsafe or invalid filters before availability helper calls', async () => {
    const invalidQueries = [
      'liffId=liff-1&menu_id=bad%20menu&from=2026-06-01&to=2026-06-02',
      'liffId=liff-1&menu_id=menu-1&staff_id=bad%20staff&from=2026-06-01&to=2026-06-02',
      'liffId=liff-1&menu_id=menu-1&from=not-a-date&to=2026-06-02',
      'liffId=liff-1&menu_id=menu-1&from=2026-02-31&to=2026-06-02',
      'liffId=liff-1&menu_id=menu-1&from=2026-06-30&to=2026-06-01',
      'liffId=liff-1&menu_id=menu-1&from=2026-06-01&to=2026-07-30',
    ];

    for (const query of invalidQueries) {
      const { app } = setupApp();
      availabilityMocks.getAvailability.mockClear();

      const res = await app.request(`/api/liff/booking/availability?${query}`);

      expect(res.status, query).toBe(400);
      expect(availabilityMocks.getAvailability, query).not.toHaveBeenCalled();
    }
  });

  test('trims valid filters before availability helper calls', async () => {
    const { app, db } = setupApp();

    const res = await app.request(
      '/api/liff/booking/availability?liffId=%20liff-1%20&menu_id=%20menu-1%20&staff_id=%20staff-1%20&from=%202026-06-01%20&to=%202026-06-02%20',
    );

    expect(res.status).toBe(200);
    expect(db.calls.find((call) => call.sql.includes('FROM line_accounts'))?.binds).toEqual(['liff-1']);
    expect(availabilityMocks.getAvailability).toHaveBeenCalledWith(db, {
      lineAccountId: 'acc-1',
      menuId: 'menu-1',
      staffId: 'staff-1',
      from: '2026-06-01',
      to: '2026-06-02',
      now: expect.any(Date),
      minLeadTimeMinutes: 60,
    });
  });
});

describe('public booking LIFF request access', () => {
  test('rejects malformed Idempotency-Key before LINE verification or idempotency lookup', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const invalidKeys = ['bad key', 'k'.repeat(129)];

    for (const key of invalidKeys) {
      const { app } = setupApp();

      const res = await app.request('/api/liff/booking/requests?liffId=liff-1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          Authorization: 'Bearer token',
        },
        body: JSON.stringify({
          menu_id: 'menu-1',
          staff_id: 'staff-1',
          starts_at: '2099-06-01T01:00:00.000Z',
        }),
      });

      expect(res.status, key).toBe(400);
      expect(fetchMock, key).not.toHaveBeenCalled();
      expect(idempotencyMocks.findIdempotencyResponse, key).not.toHaveBeenCalled();
      expect(idempotencyMocks.saveIdempotencyResponse, key).not.toHaveBeenCalled();
    }
  });

  test('rejects malformed or unsafe request payloads before LINE verification or idempotency lookup', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const invalidRequests: Array<[string, string]> = [
      ['malformed json', '{'],
      ['non-object json', JSON.stringify([])],
      ['unsafe menu id', JSON.stringify({ menu_id: 'bad menu', staff_id: 'staff-1', starts_at: '2099-06-01T01:00:00.000Z' })],
      ['unsafe staff id', JSON.stringify({ menu_id: 'menu-1', staff_id: 'bad staff', starts_at: '2099-06-01T01:00:00.000Z' })],
      ['invalid starts_at', JSON.stringify({ menu_id: 'menu-1', staff_id: 'staff-1', starts_at: 'not-a-date' })],
      ['oversized customer note', JSON.stringify({
        menu_id: 'menu-1',
        staff_id: 'staff-1',
        starts_at: '2099-06-01T01:00:00.000Z',
        customer_note: 'x'.repeat(1001),
      })],
    ];

    for (const [label, body] of invalidRequests) {
      const { app } = setupApp();

      const res = await app.request('/api/liff/booking/requests?liffId=liff-1', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'key-1',
          Authorization: 'Bearer token',
        },
        body,
      });

      expect(res.status, label).toBe(400);
      expect(fetchMock, label).not.toHaveBeenCalled();
      expect(idempotencyMocks.findIdempotencyResponse, label).not.toHaveBeenCalled();
      expect(idempotencyMocks.saveIdempotencyResponse, label).not.toHaveBeenCalled();
    }
  });

  test('trims valid request payload values before idempotency and menu lookup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ sub: 'U-verified' }),
    }));
    const { app, db } = setupApp();

    const res = await app.request('/api/liff/booking/requests?liffId=%20liff-1%20', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'key-1',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({
        menu_id: ' menu-1 ',
        staff_id: ' staff-1 ',
        starts_at: ' 2099-06-01T01:00:00.000Z ',
        customer_note: ' hello ',
      }),
    });

    expect(res.status).toBe(422);
    expect(idempotencyMocks.findIdempotencyResponse).toHaveBeenCalledWith(db, {
      key: 'key-1',
      lineAccountId: 'acc-1',
      friendId: 'friend-1',
      now: expect.any(Date),
    });
    expect(db.calls.find((call) => call.sql.includes('FROM friends') && call.sql.includes('line_user_id'))?.binds)
      .toEqual(['U-verified', 'acc-1']);
    expect(db.calls.find((call) => call.sql.includes('FROM menus m'))?.binds)
      .toEqual(['menu-1', 'staff-1', 'acc-1']);
  });
});
