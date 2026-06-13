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
          if (sql.includes('SELECT 1 AS ok FROM staff')) {
            return (bound[0] === 'staff-1' && bound[1] === 'acc-1' ? { ok: 1 } : null) as T | null;
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
        all: vi.fn(async <T>() => {
          if (sql.includes('SELECT id FROM menus WHERE line_account_id = ?')) {
            return { results: [{ id: 'menu-1' }] as T[] };
          }
          return { results: [] as T[] };
        }),
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
      };
      return stmt;
    }),
    batch: vi.fn().mockResolvedValue([]),
  };
  return db as unknown as D1Database & { calls: DbCall[]; prepare: ReturnType<typeof vi.fn> };
}

function setupApp(db = makeDb(), role?: StaffRole) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    if (role) {
      c.set('staff', { id: 'staff-1', name: 'Tajima', role });
    }
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

describe('booking admin account access', () => {
  test('rejects unsafe account_id before DB lookup', async () => {
    const { app, db } = setupApp(makeDb(), 'owner');

    const res = await app.request('/api/booking/admin/menus?account_id=bad%20account');

    expect(res.status).toBe(400);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('trims valid account_id before SQL bind', async () => {
    const { app, db } = setupApp(makeDb(), 'owner');

    const res = await app.request('/api/booking/admin/menus?account_id=%20acc-1%20');

    expect(res.status).toBe(200);
    expect(db.calls.find((call) => call.sql.includes('FROM menus'))?.binds).toEqual(['acc-1']);
  });
});

describe('booking admin path id access', () => {
  test('rejects unsafe admin path ids before DB lookup', async () => {
    const requests: Array<[string, string, RequestInit?]> = [
      ['PUT', '/api/booking/admin/menus/bad%20menu?account_id=acc-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }],
      ['DELETE', '/api/booking/admin/staff/bad%20staff?account_id=acc-1'],
      ['GET', '/api/booking/admin/staff/bad%20staff/menus?account_id=acc-1'],
      ['PATCH', '/api/booking/admin/requests/bad%20booking?account_id=acc-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      }],
    ];

    for (const [method, path, init] of requests) {
      const { app, db } = setupApp(makeDb(), 'owner');

      const res = await app.request(path, { ...init, method });

      expect(res.status, `${method} ${path}`).toBe(400);
      expect(db.prepare, `${method} ${path}`).not.toHaveBeenCalled();
    }
  });

  test('trims valid admin path ids before SQL bind', async () => {
    const menuDb = makeDb();
    const menuRes = await setupApp(menuDb, 'owner').app.request(
      '/api/booking/admin/menus/%20menu-1%20?account_id=%20acc-1%20',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Menu',
          duration_minutes: 30,
          base_price: 1000,
        }),
      },
    );
    expect(menuRes.status).toBe(200);
    expect(menuDb.calls.find((call) => call.sql.includes('UPDATE menus'))?.binds.slice(-2))
      .toEqual(['menu-1', 'acc-1']);

    const staffMenuDb = makeDb();
    const staffMenuRes = await setupApp(staffMenuDb, 'owner').app.request(
      '/api/booking/admin/staff/%20staff-1%20/menus?account_id=%20acc-1%20',
    );
    expect(staffMenuRes.status).toBe(200);
    expect(staffMenuDb.calls.find((call) => call.sql.includes('SELECT 1 AS ok FROM staff'))?.binds)
      .toEqual(['staff-1', 'acc-1']);
    expect(staffMenuDb.calls.find((call) => call.sql.includes('FROM menus m'))?.binds)
      .toEqual(['acc-1', 'staff-1']);

    const requestDb = makeDb();
    const requestRes = await setupApp(requestDb, 'owner').app.request(
      '/api/booking/admin/requests/%20booking-1%20?account_id=%20acc-1%20',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      },
    );
    expect(requestRes.status).toBe(404);
    expect(requestDb.calls.find((call) => call.sql.includes('FROM bookings'))?.binds)
      .toEqual(['booking-1', 'acc-1']);
  });
});

describe('booking admin payload and query access', () => {
  test('rejects invalid menu and staff payloads before DB writes', async () => {
    const requests: Array<[string, string, string]> = [
      ['POST', '/api/booking/admin/menus?account_id=acc-1', '{'],
      ['POST', '/api/booking/admin/menus?account_id=acc-1', JSON.stringify({
        name: ' ',
        duration_minutes: 30,
        base_price: 1000,
      })],
      ['POST', '/api/booking/admin/menus?account_id=acc-1', JSON.stringify({
        name: 'Menu',
        duration_minutes: 0,
        base_price: 1000,
      })],
      ['POST', '/api/booking/admin/staff?account_id=acc-1', JSON.stringify({
        name: 'Staff',
        display_name: 'Staff',
        is_designation_optional: 'yes',
      })],
      ['POST', '/api/booking/admin/staff?account_id=acc-1', JSON.stringify({
        name: ' ',
        display_name: 'Staff',
      })],
    ];

    for (const [method, path, body] of requests) {
      const { app, db } = setupApp(makeDb(), 'owner');

      const res = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(res.status, `${method} ${path} ${body}`).toBe(400);
      expect(db.calls.some((call) => call.sql.includes('INSERT INTO menus')), body).toBe(false);
      expect(db.calls.some((call) => call.sql.includes('INSERT INTO staff')), body).toBe(false);
    }
  });

  test('trims valid menu and staff payloads before DB writes', async () => {
    const menuDb = makeDb();
    const menuRes = await setupApp(menuDb, 'owner').app.request(
      '/api/booking/admin/menus?account_id=acc-1',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: ' Menu ',
          category_label: ' Category ',
          description: ' Description ',
          duration_minutes: 45,
          buffer_after_minutes: 5,
          base_price: 2500,
          sort_order: 3,
        }),
      },
    );

    expect(menuRes.status).toBe(201);
    expect(menuDb.calls.find((call) => call.sql.includes('INSERT INTO menus'))?.binds).toEqual([
      expect.any(String),
      'acc-1',
      'Menu',
      'Category',
      'Description',
      45,
      5,
      2500,
      3,
    ]);

    const staffDb = makeDb();
    const staffRes = await setupApp(staffDb, 'owner').app.request(
      '/api/booking/admin/staff?account_id=acc-1',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: ' staff-name ',
          display_name: ' Display Name ',
          role: ' Stylist ',
          profile_image_url: ' https://example.com/staff.png ',
          bio: ' Bio ',
          sort_order: 4,
          is_designation_optional: 1,
        }),
      },
    );

    expect(staffRes.status).toBe(201);
    expect(staffDb.calls.find((call) => call.sql.includes('INSERT INTO staff'))?.binds).toEqual([
      expect.any(String),
      'acc-1',
      'staff-name',
      'Display Name',
      'Stylist',
      'https://example.com/staff.png',
      'Bio',
      4,
      1,
    ]);
  });

  test('rejects invalid staff menu and shift payloads before DB writes', async () => {
    const requests: Array<[string, string, string]> = [
      ['PUT', '/api/booking/admin/staff/staff-1/menus?account_id=acc-1', JSON.stringify({
        menus: [{ menu_id: 'bad menu', is_offered: true }],
      })],
      ['PUT', '/api/booking/admin/staff/staff-1/menus?account_id=acc-1', JSON.stringify({
        menus: [{ menu_id: 'menu-1', is_offered: 'yes' }],
      })],
      ['PUT', '/api/booking/admin/staff/staff-1/shifts?account_id=acc-1', JSON.stringify({
        shifts: [{ work_date: '2026-02-31', start_time: '10:00', end_time: '11:00' }],
      })],
      ['PUT', '/api/booking/admin/staff/staff-1/shifts?account_id=acc-1', JSON.stringify({
        shifts: [{ work_date: '2026-06-01', start_time: '12:00', end_time: '11:00' }],
      })],
      ['POST', '/api/booking/admin/staff/staff-1/shifts/generate?account_id=acc-1', JSON.stringify({
        from_date: '2026-06-01',
        weeks: 53,
        weekly_template: { mon: { start: '10:00', end: '19:00' } },
      })],
      ['POST', '/api/booking/admin/staff/staff-1/shifts/generate?account_id=acc-1', JSON.stringify({
        from_date: '2026-06-01',
        weeks: 1,
        weekly_template: { mon: { start: '19:00', end: '10:00' } },
      })],
    ];

    for (const [method, path, body] of requests) {
      const { app, db } = setupApp(makeDb(), 'owner');

      const res = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(res.status, `${method} ${path} ${body}`).toBe(400);
      expect(db.prepare, body).not.toHaveBeenCalled();
    }
  });

  test('trims valid staff menu and shift payload values before DB writes', async () => {
    const staffMenuDb = makeDb();
    const staffMenuRes = await setupApp(staffMenuDb, 'owner').app.request(
      '/api/booking/admin/staff/%20staff-1%20/menus?account_id=%20acc-1%20',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          menus: [{
            menu_id: ' menu-1 ',
            is_offered: true,
            override_duration_minutes: 35,
            override_price: 4000,
          }],
        }),
      },
    );

    expect(staffMenuRes.status).toBe(200);
    expect(staffMenuDb.calls.find((call) => call.sql.includes('SELECT 1 AS ok FROM staff'))?.binds)
      .toEqual(['staff-1', 'acc-1']);
    expect(staffMenuDb.calls.find((call) => call.sql.includes('DELETE FROM staff_menus'))?.binds)
      .toEqual(['staff-1']);
    expect(staffMenuDb.calls.find((call) => call.sql.includes('INSERT INTO staff_menus'))?.binds)
      .toEqual(['staff-1', 'menu-1', 1, 35, 4000]);

    const shiftDb = makeDb();
    const shiftRes = await setupApp(shiftDb, 'owner').app.request(
      '/api/booking/admin/staff/%20staff-1%20/shifts?account_id=%20acc-1%20',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shifts: [{ work_date: ' 2026-06-01 ', start_time: ' 10:00 ', end_time: ' 18:00 ' }],
        }),
      },
    );

    expect(shiftRes.status).toBe(200);
    expect(shiftDb.calls.find((call) => call.sql.includes('INSERT INTO staff_shifts'))?.binds)
      .toEqual([expect.any(String), 'staff-1', '2026-06-01', '10:00', '18:00']);
  });

  test('rejects invalid shift query before lookup and trims valid date range', async () => {
    const invalidDb = makeDb();
    const invalidRes = await setupApp(invalidDb, 'owner').app.request(
      '/api/booking/admin/staff/staff-1/shifts?account_id=acc-1&from=2026-02-31&to=2026-06-02',
    );

    expect(invalidRes.status).toBe(400);
    expect(invalidDb.prepare).not.toHaveBeenCalled();

    const validDb = makeDb();
    const validRes = await setupApp(validDb, 'owner').app.request(
      '/api/booking/admin/staff/%20staff-1%20/shifts?account_id=%20acc-1%20&from=%202026-06-01%20&to=%202026-06-02%20',
    );

    expect(validRes.status).toBe(200);
    expect(validDb.calls.find((call) => call.sql.includes('FROM staff_shifts'))?.binds)
      .toEqual(['staff-1', '2026-06-01', '2026-06-02']);
  });

  test('rejects invalid request status/action before booking SQL and trims valid values', async () => {
    const invalidStatusDb = makeDb();
    const invalidStatusRes = await setupApp(invalidStatusDb, 'owner').app.request(
      '/api/booking/admin/requests?account_id=acc-1&status=bad%20status',
    );

    expect(invalidStatusRes.status).toBe(400);
    expect(invalidStatusDb.prepare).not.toHaveBeenCalled();

    const validStatusDb = makeDb();
    const validStatusRes = await setupApp(validStatusDb, 'owner').app.request(
      '/api/booking/admin/requests?account_id=%20acc-1%20&status=%20confirmed%20',
    );

    expect(validStatusRes.status).toBe(200);
    expect(validStatusDb.calls.find((call) => call.sql.includes('FROM bookings b'))?.binds)
      .toEqual(['acc-1', 'confirmed']);

    const invalidActionDb = makeDb();
    const invalidActionRes = await setupApp(invalidActionDb, 'owner').app.request(
      '/api/booking/admin/requests/booking-1?account_id=acc-1',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve later' }),
      },
    );

    expect(invalidActionRes.status).toBe(400);
    expect(invalidActionDb.calls.some((call) => call.sql.includes('FROM bookings'))).toBe(false);

    const validActionDb = makeDb();
    const validActionRes = await setupApp(validActionDb, 'owner').app.request(
      '/api/booking/admin/requests/%20booking-1%20?account_id=%20acc-1%20',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: ' approve ' }),
      },
    );

    expect(validActionRes.status).toBe(404);
    expect(validActionDb.calls.find((call) => call.sql.includes('FROM bookings'))?.binds)
      .toEqual(['booking-1', 'acc-1']);
  });
});

describe('public booking LIFF menu staff access', () => {
  test('rejects unsafe menu path id before staff lookup', async () => {
    const { app, db } = setupApp();

    const res = await app.request('/api/liff/booking/menus/bad%20menu/staff?liffId=liff-1');

    expect(res.status).toBe(400);
    expect(db.calls.some((call) => call.sql.includes('FROM staff s'))).toBe(false);
    expect(availabilityMocks.getAvailability).not.toHaveBeenCalled();
  });

  test('trims valid menu path id before staff lookup', async () => {
    const { app, db } = setupApp();

    const res = await app.request('/api/liff/booking/menus/%20menu-1%20/staff?liffId=%20liff-1%20');

    expect(res.status).toBe(200);
    expect(db.calls.find((call) => call.sql.includes('FROM line_accounts'))?.binds).toEqual(['liff-1']);
    expect(db.calls.find((call) => call.sql.includes('FROM staff s'))?.binds).toEqual(['acc-1', 'menu-1']);
  });
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
