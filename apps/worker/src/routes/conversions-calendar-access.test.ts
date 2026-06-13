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
  dbMocks.createCalendarConnection.mockResolvedValue({
    id: 'conn-created',
    calendar_id: 'primary',
    access_token: null,
    refresh_token: null,
    api_key: 'calendar-key',
    auth_type: 'api_key',
    is_active: 1,
    created_at: '2026-06-13T10:00:00.000',
    updated_at: '2026-06-13T10:00:00.000',
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

  test('conversion track rejects malformed or unsafe payloads before friend access checks', async () => {
    const requests: BodyInit[] = [
      '{',
      JSON.stringify([]),
      JSON.stringify({ conversionPointId: 1, friendId: 'friend-visible' }),
      JSON.stringify({ conversionPointId: 'point 1', friendId: 'friend-visible' }),
      JSON.stringify({ conversionPointId: 'point-1', friendId: 'friend visible' }),
      JSON.stringify({ conversionPointId: 'point-1', friendId: 'friend-visible', userId: 123 }),
      JSON.stringify({ conversionPointId: 'point-1', friendId: 'friend-visible', affiliateCode: 'bad code' }),
      JSON.stringify({ conversionPointId: 'point-1', friendId: 'friend-visible', metadata: [] }),
      JSON.stringify({ conversionPointId: 'point-1', friendId: 'friend-visible', metadata: { note: 'x'.repeat(16 * 1024 + 1) } }),
    ];

    for (const body of requests) {
      const db = makeDb({ visibleFriendIds: ['friend-visible'] });
      const res = await setupApp(db, 'staff').request('/api/conversions/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(res.status).toBe(400);
      expect(db.calls).toEqual([]);
    }

    expect(dbMocks.trackConversion).not.toHaveBeenCalled();
  });

  test('conversion track trims and serializes valid payloads before DB writes', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/conversions/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversionPointId: ' point-1 ',
        friendId: ' friend-visible ',
        userId: ' ',
        affiliateCode: ' aff_2026 ',
        metadata: { source: 'support', amount: 9800 },
      }),
    });

    expect(res.status).toBe(201);
    expect(db.calls[0]).toMatchObject({ method: 'first', binds: ['friend-visible', 'staff-1', '%田島%', '%田島%', '%田島%'] });
    expect(dbMocks.trackConversion).toHaveBeenCalledWith(db, {
      conversionPointId: 'point-1',
      friendId: 'friend-visible',
      userId: null,
      affiliateCode: 'aff_2026',
      metadata: JSON.stringify({ source: 'support', amount: 9800 }),
    });
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

  test('conversion events reject unsafe filters before friend access checks or SQL bind', async () => {
    const queries = [
      'conversionPointId=bad%20point',
      'friendId=bad%20friend',
      'affiliateCode=bad%20code',
      'startDate=not-a-date',
      'endDate=not-a-date',
      'startDate=2026-07-01&endDate=2026-06-01',
    ];

    for (const query of queries) {
      const db = makeDb({ visibleFriendIds: ['friend-visible'] });
      const res = await setupApp(db, 'staff').request(`/api/conversions/events?${query}`);

      expect(res.status, query).toBe(400);
      expect(db.calls, query).toEqual([]);
    }
  });

  test('conversion events trim valid filters before friend access checks and SQL bind', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff')
      .request('/api/conversions/events?conversionPointId=%20point-1%20&friendId=%20friend-visible%20&affiliateCode=%20aff_2026%20&startDate=%202026-06-01%20&endDate=%202026-06-30T23%3A59%3A59%2B09%3A00%20&limit=10&offset=2');

    expect(res.status).toBe(200);
    expect(db.calls[0]).toMatchObject({ method: 'first', binds: ['friend-visible', 'staff-1', '%田島%', '%田島%', '%田島%'] });
    const listCall = db.calls.find((call) => call.sql.includes('FROM conversion_events ce'));
    expect(listCall?.binds).toEqual([
      'point-1',
      'friend-visible',
      'aff_2026',
      '2026-06-01',
      '2026-06-30T23:59:59+09:00',
      'staff-1',
      '%田島%',
      '%田島%',
      '%田島%',
      10,
      2,
    ]);
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

  test('conversion report rejects unsafe date filters before SQL bind', async () => {
    const queries = [
      'startDate=not-a-date',
      'endDate=not-a-date',
      'startDate=2026-07-01&endDate=2026-06-01',
    ];

    for (const query of queries) {
      const db = makeDb({ visibleFriendIds: ['friend-visible'] });
      const res = await setupApp(db, 'staff').request(`/api/conversions/report?${query}`);

      expect(res.status, query).toBe(400);
      expect(db.calls, query).toEqual([]);
    }
  });

  test('conversion report trims valid date filters before SQL bind', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff')
      .request('/api/conversions/report?startDate=%202026-06-01%20&endDate=%202026-06-30T23%3A59%3A59%2B09%3A00%20');

    expect(res.status).toBe(200);
    const reportCall = db.calls.find((call) => call.sql.includes('FROM conversion_points cp'));
    expect(reportCall?.binds).toEqual([
      '2026-06-01',
      '2026-06-30T23:59:59+09:00',
      'staff-1',
      '%田島%',
      '%田島%',
      '%田島%',
    ]);
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
  test('calendar connection create rejects malformed JSON before DB writes', async () => {
    const db = makeDb();

    const res = await setupApp(db, 'owner').request('/api/integrations/google-calendar/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createCalendarConnection).not.toHaveBeenCalled();
  });

  test('calendar connection create rejects unsafe payloads before DB writes', async () => {
    const db = makeDb();

    const res = await setupApp(db, 'owner').request('/api/integrations/google-calendar/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId: 'primary\nunsafe', authType: 'service_account' }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createCalendarConnection).not.toHaveBeenCalled();
  });

  test('calendar connection create trims valid payloads before DB writes', async () => {
    const db = makeDb();

    const res = await setupApp(db, 'owner').request('/api/integrations/google-calendar/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId: ' primary ', authType: ' api_key ', apiKey: ' calendar-key ' }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createCalendarConnection).toHaveBeenCalledWith(db, {
      calendarId: 'primary',
      authType: 'api_key',
      accessToken: undefined,
      refreshToken: undefined,
      apiKey: 'calendar-key',
    });
  });

  test('calendar path IDs reject malformed values before DB helpers', async () => {
    const db = makeDb();

    const deleteConnection = await setupApp(db, 'owner').request('/api/integrations/google-calendar/bad%20conn', {
      method: 'DELETE',
    });
    const updateStatus = await setupApp(db, 'owner').request('/api/integrations/google-calendar/bookings/bad%20booking/status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    });

    expect(deleteConnection.status).toBe(400);
    expect(updateStatus.status).toBe(400);
    expect(dbMocks.deleteCalendarConnection).not.toHaveBeenCalled();
    expect(dbMocks.getCalendarBookingById).not.toHaveBeenCalled();
    expect(dbMocks.getCalendarConnectionById).not.toHaveBeenCalled();
    expect(dbMocks.updateCalendarBookingStatus).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  test('calendar path IDs are trimmed before DB helpers', async () => {
    const db = makeDb();
    dbMocks.getCalendarBookingById.mockResolvedValue({
      id: 'booking-1',
      connection_id: 'conn-1',
      friend_id: null,
      event_id: null,
      title: '相談予約',
      start_at: '2026-06-14T10:00:00.000',
      end_at: '2026-06-14T11:00:00.000',
      status: 'confirmed',
      metadata: null,
      created_at: '2026-06-13T10:00:00.000',
    });

    const deleteConnection = await setupApp(db, 'owner').request('/api/integrations/google-calendar/%20conn-1%20', {
      method: 'DELETE',
    });
    const updateStatus = await setupApp(db, 'owner').request('/api/integrations/google-calendar/bookings/%20booking-1%20/status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed' }),
    });

    expect(deleteConnection.status).toBe(200);
    expect(updateStatus.status).toBe(200);
    expect(dbMocks.deleteCalendarConnection).toHaveBeenCalledWith(db, 'conn-1');
    expect(dbMocks.getCalendarBookingById).toHaveBeenCalledWith(db, 'booking-1');
    expect(dbMocks.updateCalendarBookingStatus).toHaveBeenCalledWith(db, 'booking-1', 'completed');
  });

  test('calendar slots clamp invalid numeric query values before generating slots', async () => {
    const db = makeDb();
    dbMocks.getCalendarConnectionById.mockResolvedValue({
      id: 'conn-1',
      calendar_id: 'calendar-1',
      auth_type: 'api_key',
      access_token: null,
      is_active: 1,
      created_at: '2026-06-13T10:00:00.000',
      updated_at: '2026-06-13T10:00:00.000',
    });
    dbMocks.getBookingsInRange.mockResolvedValue([]);

    const res = await setupApp(db, 'staff')
      .request('/api/integrations/google-calendar/slots?connectionId=conn-1&date=2026-06-14&slotMinutes=0&startHour=abc&endHour=10');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ startAt: string; endAt: string; available: boolean }> };
    expect(body.data).toHaveLength(1);
    expect(dbMocks.getBookingsInRange).toHaveBeenCalledWith(
      db,
      'conn-1',
      '2026-06-14T09:00:00',
      '2026-06-14T10:00:00',
    );
  });

  test('calendar slots reject windows where startHour is not before endHour', async () => {
    const db = makeDb();

    const res = await setupApp(db, 'staff')
      .request('/api/integrations/google-calendar/slots?connectionId=conn-1&date=2026-06-14&startHour=18&endHour=9');

    expect(res.status).toBe(400);
    expect(dbMocks.getCalendarConnectionById).not.toHaveBeenCalled();
    expect(dbMocks.getBookingsInRange).not.toHaveBeenCalled();
  });

  test('calendar slots reject unsafe connection or date query values before lookups', async () => {
    const queries = [
      'connectionId=bad%20conn&date=2026-06-14',
      'connectionId=conn-1&date=not-a-date',
      'connectionId=conn-1&date=2026-99-99',
      'connectionId=conn-1&date=2026-02-31',
    ];

    for (const query of queries) {
      const db = makeDb();
      const res = await setupApp(db, 'staff').request(`/api/integrations/google-calendar/slots?${query}`);

      expect(res.status, query).toBe(400);
      expect(dbMocks.getCalendarConnectionById, query).not.toHaveBeenCalled();
      expect(dbMocks.getBookingsInRange, query).not.toHaveBeenCalled();
    }
  });

  test('calendar slots trim valid connection and date query values before lookups', async () => {
    const db = makeDb();
    dbMocks.getCalendarConnectionById.mockResolvedValue({
      id: 'conn-1',
      calendar_id: 'calendar-1',
      auth_type: 'api_key',
      access_token: null,
      is_active: 1,
      created_at: '2026-06-13T10:00:00.000',
      updated_at: '2026-06-13T10:00:00.000',
    });
    dbMocks.getBookingsInRange.mockResolvedValue([]);

    const res = await setupApp(db, 'staff')
      .request('/api/integrations/google-calendar/slots?connectionId=%20conn-1%20&date=%202026-06-14%20&startHour=9&endHour=10');

    expect(res.status).toBe(200);
    expect(dbMocks.getCalendarConnectionById).toHaveBeenCalledWith(db, 'conn-1');
    expect(dbMocks.getBookingsInRange).toHaveBeenCalledWith(
      db,
      'conn-1',
      '2026-06-14T09:00:00',
      '2026-06-14T10:00:00',
    );
  });

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

  test('calendar bookings reject unsafe query values before friend access checks or SQL bind', async () => {
    const queries = [
      'connectionId=bad%20conn',
      'friendId=bad%20friend',
    ];

    for (const query of queries) {
      const db = makeDb({ visibleFriendIds: ['friend-visible'] });
      const res = await setupApp(db, 'staff').request(`/api/integrations/google-calendar/bookings?${query}`);

      expect(res.status, query).toBe(400);
      expect(db.calls, query).toEqual([]);
    }
  });

  test('calendar bookings trim valid query values before friend access checks and SQL bind', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff')
      .request('/api/integrations/google-calendar/bookings?connectionId=%20conn-1%20&friendId=%20friend-visible%20');

    expect(res.status).toBe(200);
    expect(db.calls[0]).toMatchObject({ method: 'first', binds: ['friend-visible', 'staff-1', '%田島%', '%田島%', '%田島%'] });
    const listCall = db.calls.find((call) => call.sql.includes('FROM calendar_bookings cb'));
    expect(listCall?.binds).toEqual(['friend-visible', 'conn-1', 'staff-1', '%田島%', '%田島%', '%田島%']);
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

  test('calendar booking create rejects malformed JSON before DB writes', async () => {
    const db = makeDb();

    const res = await setupApp(db, 'staff').request('/api/integrations/google-calendar/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });

    expect(res.status).toBe(400);
    expect(db.calls).toEqual([]);
    expect(dbMocks.createCalendarBooking).not.toHaveBeenCalled();
    expect(dbMocks.getCalendarConnectionById).not.toHaveBeenCalled();
  });

  test('calendar booking create rejects invalid windows before friend access checks', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/integrations/google-calendar/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: 'conn-1',
        friendId: 'friend-hidden',
        title: '相談予約',
        startAt: '2026-06-14T11:00:00.000+09:00',
        endAt: '2026-06-14T10:00:00.000+09:00',
      }),
    });

    expect(res.status).toBe(400);
    expect(db.calls).toEqual([]);
    expect(dbMocks.createCalendarBooking).not.toHaveBeenCalled();
  });

  test('calendar booking create rejects oversized metadata before DB writes', async () => {
    const db = makeDb();

    const res = await setupApp(db, 'owner').request('/api/integrations/google-calendar/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: 'conn-1',
        title: '相談予約',
        startAt: '2026-06-14T10:00:00.000+09:00',
        endAt: '2026-06-14T11:00:00.000+09:00',
        metadata: { note: 'x'.repeat(16 * 1024 + 1) },
      }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.createCalendarBooking).not.toHaveBeenCalled();
    expect(dbMocks.getCalendarConnectionById).not.toHaveBeenCalled();
  });

  test('calendar booking create trims valid payloads before DB writes', async () => {
    const db = makeDb();

    const res = await setupApp(db, 'owner').request('/api/integrations/google-calendar/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: ' conn-1 ',
        title: ' 相談予約 ',
        startAt: ' 2026-06-14T10:00:00.000+09:00 ',
        endAt: ' 2026-06-14T11:00:00.000+09:00 ',
        description: ' 初回相談 ',
        metadata: { source: 'liff' },
      }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createCalendarBooking).toHaveBeenCalledWith(db, expect.objectContaining({
      connectionId: 'conn-1',
      title: '相談予約',
      startAt: '2026-06-14T10:00:00.000+09:00',
      endAt: '2026-06-14T11:00:00.000+09:00',
      description: '初回相談',
      metadata: JSON.stringify({ source: 'liff' }),
    }));
    expect(dbMocks.getCalendarConnectionById).toHaveBeenCalledWith(db, 'conn-1');
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

  test('calendar booking status rejects malformed or invalid payloads before booking lookup', async () => {
    const db = makeDb();

    const malformed = await setupApp(db, 'owner').request('/api/integrations/google-calendar/bookings/booking-1/status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    const invalid = await setupApp(db, 'owner').request('/api/integrations/google-calendar/bookings/booking-1/status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'deleted' }),
    });

    expect(malformed.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(dbMocks.getCalendarBookingById).not.toHaveBeenCalled();
    expect(dbMocks.updateCalendarBookingStatus).not.toHaveBeenCalled();
  });
});
