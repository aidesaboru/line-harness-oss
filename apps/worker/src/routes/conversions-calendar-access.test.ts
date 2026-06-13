import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getConversionPoints: vi.fn(),
  getConversionPointById: vi.fn(),
  createConversionPoint: vi.fn(),
  deleteConversionPoint: vi.fn(),
  trackConversion: vi.fn(),
  getCalendarConnections: vi.fn(),
  getCalendarConnectionById: vi.fn(),
  createCalendarConnection: vi.fn(),
  deleteCalendarConnection: vi.fn(),
  getCalendarBookingById: vi.fn(),
  createCalendarBooking: vi.fn(),
  updateCalendarBookingStatus: vi.fn(),
  updateCalendarBookingEventId: vi.fn(),
  getBookingsInRange: vi.fn(),
  toJstString: vi.fn((date: Date) => date.toISOString()),
};

vi.mock('@line-crm/db', () => dbMocks);
vi.mock('../services/google-calendar.js', () => ({
  GoogleCalendarClient: vi.fn(),
}));

const { conversions } = await import('./conversions.js');
const { calendar } = await import('./calendar.js');

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

type DbCall = { method: 'all' | 'first' | 'run'; sql: string; binds: unknown[] };

function makeDb(state: {
  visibleFriendIds?: string[];
  conversionEvents?: Array<{
    id: string;
    conversion_point_id: string;
    friend_id: string;
    user_id: string | null;
    affiliate_code: string | null;
    metadata: string | null;
    created_at: string;
  }>;
  calendarBookings?: Array<{
    id: string;
    connection_id: string;
    friend_id: string | null;
    event_id: string | null;
    title: string;
    start_at: string;
    end_at: string;
    status: string;
    metadata: string | null;
    created_at: string;
  }>;
} = {}) {
  const visibleFriendIds = new Set(state.visibleFriendIds ?? []);
  const calls: DbCall[] = [];
  const conversionEvents = state.conversionEvents ?? [];
  const calendarBookings = state.calendarBookings ?? [];

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>() {
          calls.push({ method: 'first', sql, binds: bound });
          if (sql.startsWith('SELECT 1 AS ok WHERE')) {
            const [friendId] = bound as [string];
            return (visibleFriendIds.has(friendId) ? { ok: 1 } : null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          calls.push({ method: 'all', sql, binds: bound });
          if (sql.includes('FROM conversion_events ce')) {
            const scoped = sql.includes('sc_friend_scope.friend_id = ce.friend_id');
            return {
              results: (scoped
                ? conversionEvents.filter((event) => visibleFriendIds.has(event.friend_id))
                : conversionEvents) as T[],
            };
          }
          if (sql.includes('FROM conversion_points cp')) {
            return {
              results: [
                {
                  conversion_point_id: 'point-1',
                  conversion_point_name: '購入',
                  event_type: 'purchase',
                  total_count: sql.includes('sc_friend_scope.friend_id = ce.friend_id') ? 1 : 2,
                  total_value: 1000,
                },
              ] as T[],
            };
          }
          if (sql.includes('FROM calendar_bookings cb')) {
            const scoped = sql.includes('sc_friend_scope.friend_id = cb.friend_id');
            return {
              results: (scoped
                ? calendarBookings.filter((booking) => booking.friend_id && visibleFriendIds.has(booking.friend_id))
                : calendarBookings) as T[],
            };
          }
          return { results: [] as T[] };
        },
        async run() {
          calls.push({ method: 'run', sql, binds: bound });
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database & { calls: DbCall[] };
  db.calls = calls;
  return db;
}

function setupApp(db: D1Database, role: StaffRole = 'staff') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '田島', role });
    c.env = { DB: db };
    await next();
  });
  app.route('/', conversions);
  app.route('/', calendar);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.trackConversion.mockResolvedValue({
    id: 'event-created',
    conversion_point_id: 'point-1',
    friend_id: 'friend-visible',
    user_id: null,
    affiliate_code: null,
    metadata: null,
    created_at: '2026-06-13T10:00:00.000',
  });
  dbMocks.createCalendarBooking.mockResolvedValue({
    id: 'booking-created',
    connection_id: 'conn-1',
    friend_id: 'friend-visible',
    event_id: null,
    title: '相談予約',
    start_at: '2026-06-14T10:00:00.000',
    end_at: '2026-06-14T11:00:00.000',
    status: 'confirmed',
    metadata: null,
    created_at: '2026-06-13T10:00:00.000',
  });
  dbMocks.getCalendarConnectionById.mockResolvedValue(null);
  dbMocks.updateCalendarBookingStatus.mockResolvedValue(undefined);
});

describe('conversion friend visibility guards', () => {
  test('staff cannot track a conversion for a hidden friend', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/conversions/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversionPointId: 'point-1', friendId: 'friend-hidden' }),
    });

    expect(res.status).toBe(404);
    expect(dbMocks.trackConversion).not.toHaveBeenCalled();
  });

  test('staff conversion events are scoped to support-visible friends', async () => {
    const db = makeDb({
      visibleFriendIds: ['friend-visible'],
      conversionEvents: [
        {
          id: 'event-visible',
          conversion_point_id: 'point-1',
          friend_id: 'friend-visible',
          user_id: null,
          affiliate_code: null,
          metadata: null,
          created_at: '2026-06-13T10:00:00.000',
        },
        {
          id: 'event-hidden',
          conversion_point_id: 'point-1',
          friend_id: 'friend-hidden',
          user_id: null,
          affiliate_code: null,
          metadata: null,
          created_at: '2026-06-13T09:00:00.000',
        },
      ],
    });

    const res = await setupApp(db, 'staff').request('/api/conversions/events?limit=10&offset=5');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; friendId: string }> };
    expect(body.data).toEqual([{ id: 'event-visible', conversionPointId: 'point-1', friendId: 'friend-visible', userId: null, affiliateCode: null, metadata: null, createdAt: '2026-06-13T10:00:00.000' }]);
    const listCall = db.calls.find((call) => call.sql.includes('FROM conversion_events ce'));
    expect(listCall?.sql).toContain('sc_friend_scope.friend_id = ce.friend_id');
    expect(listCall?.binds).toEqual(['staff-1', '%田島%', '%田島%', '%田島%', 10, 5]);
  });

  test('conversion events clamp invalid limit and fractional offset before SQL bind', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/conversions/events?limit=abc&offset=1.9');

    expect(res.status).toBe(200);
    const listCall = db.calls.find((call) => call.sql.includes('FROM conversion_events ce'));
    expect(listCall?.binds.slice(-2)).toEqual([100, 1]);
  });

  test('conversion events reset non-finite offset before SQL bind', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/conversions/events?offset=Infinity');

    expect(res.status).toBe(200);
    const listCall = db.calls.find((call) => call.sql.includes('FROM conversion_events ce'));
    expect(listCall?.binds.slice(-2)).toEqual([100, 0]);
  });

  test('staff cannot request hidden friend conversion events directly', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/conversions/events?friendId=friend-hidden');

    expect(res.status).toBe(404);
    expect(db.calls.some((call) => call.sql.includes('FROM conversion_events ce'))).toBe(false);
  });

  test('staff conversion report is scoped to support-visible friends', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/conversions/report?startDate=2026-06-01');

    expect(res.status).toBe(200);
    const reportCall = db.calls.find((call) => call.sql.includes('FROM conversion_points cp'));
    expect(reportCall?.sql).toContain('sc_friend_scope.friend_id = ce.friend_id');
    expect(reportCall?.binds).toEqual(['2026-06-01', 'staff-1', '%田島%', '%田島%', '%田島%']);
  });

  test('owner conversion events keep the global scope', async () => {
    const db = makeDb({
      visibleFriendIds: ['friend-visible'],
      conversionEvents: [
        {
          id: 'event-hidden',
          conversion_point_id: 'point-1',
          friend_id: 'friend-hidden',
          user_id: null,
          affiliate_code: null,
          metadata: null,
          created_at: '2026-06-13T09:00:00.000',
        },
      ],
    });

    const res = await setupApp(db, 'owner').request('/api/conversions/events?limit=10');

    expect(res.status).toBe(200);
    const listCall = db.calls.find((call) => call.sql.includes('FROM conversion_events ce'));
    expect(listCall?.sql).not.toContain('sc_friend_scope');
    expect(listCall?.binds).toEqual([10, 0]);
  });
});

describe('calendar booking friend visibility guards', () => {
  test('staff calendar bookings list is scoped to support-visible friends', async () => {
    const db = makeDb({
      visibleFriendIds: ['friend-visible'],
      calendarBookings: [
        {
          id: 'booking-visible',
          connection_id: 'conn-1',
          friend_id: 'friend-visible',
          event_id: null,
          title: '見える予約',
          start_at: '2026-06-14T10:00:00.000',
          end_at: '2026-06-14T11:00:00.000',
          status: 'confirmed',
          metadata: null,
          created_at: '2026-06-13T10:00:00.000',
        },
        {
          id: 'booking-hidden',
          connection_id: 'conn-1',
          friend_id: 'friend-hidden',
          event_id: null,
          title: '隠れた予約',
          start_at: '2026-06-14T12:00:00.000',
          end_at: '2026-06-14T13:00:00.000',
          status: 'confirmed',
          metadata: null,
          created_at: '2026-06-13T10:00:00.000',
        },
      ],
    });

    const res = await setupApp(db, 'staff').request('/api/integrations/google-calendar/bookings?connectionId=conn-1');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; friendId: string | null }> };
    expect(body.data).toMatchObject([{ id: 'booking-visible', friendId: 'friend-visible' }]);
    const listCall = db.calls.find((call) => call.sql.includes('FROM calendar_bookings cb'));
    expect(listCall?.sql).toContain('sc_friend_scope.friend_id = cb.friend_id');
    expect(listCall?.binds).toEqual(['conn-1', 'staff-1', '%田島%', '%田島%', '%田島%']);
  });

  test('staff cannot create a calendar booking for a hidden friend', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/integrations/google-calendar/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: 'conn-1',
        friendId: 'friend-hidden',
        title: '相談予約',
        startAt: '2026-06-14T10:00:00.000',
        endAt: '2026-06-14T11:00:00.000',
      }),
    });

    expect(res.status).toBe(404);
    expect(dbMocks.createCalendarBooking).not.toHaveBeenCalled();
  });

  test('staff cannot update a hidden friend calendar booking by booking id', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });
    dbMocks.getCalendarBookingById.mockResolvedValue({
      id: 'booking-hidden',
      connection_id: 'conn-1',
      friend_id: 'friend-hidden',
      event_id: null,
      title: '隠れた予約',
      start_at: '2026-06-14T10:00:00.000',
      end_at: '2026-06-14T11:00:00.000',
      status: 'confirmed',
      metadata: null,
      created_at: '2026-06-13T10:00:00.000',
    });

    const res = await setupApp(db, 'staff').request('/api/integrations/google-calendar/bookings/booking-hidden/status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    });

    expect(res.status).toBe(404);
    expect(dbMocks.updateCalendarBookingStatus).not.toHaveBeenCalled();
  });
});
