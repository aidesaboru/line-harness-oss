import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const availabilityMocks = {
  computeSlots: vi.fn(),
  getAvailability: vi.fn(),
};

const dbMocks = {
  getLineAccounts: vi.fn(),
};

vi.mock('../services/availability.js', () => availabilityMocks);
vi.mock('@line-crm/db', () => dbMocks);

const { default: booking } = await import('./booking.js');

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database };
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
    c.env = { DB: db };
    await next();
  });
  app.route('/', booking);
  return { app, db };
}

beforeEach(() => {
  vi.clearAllMocks();
  availabilityMocks.getAvailability.mockResolvedValue({ by_staff: [] });
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
