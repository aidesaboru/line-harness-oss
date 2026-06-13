import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getAutomations: vi.fn(),
  getAutomationById: vi.fn(),
  createAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  getAutomationLogs: vi.fn(),
  getAutoReplies: vi.fn(),
  getAutoReplyById: vi.fn(),
  createAutoReply: vi.fn(),
  updateAutoReply: vi.fn(),
  deleteAutoReply: vi.fn(),
  getTemplateById: vi.fn(),
  getTrafficPools: vi.fn(),
  getTrafficPoolById: vi.fn(),
  getTrafficPoolBySlug: vi.fn(),
  createTrafficPool: vi.fn(),
  updateTrafficPool: vi.fn(),
  deleteTrafficPool: vi.fn(),
  getPoolAccounts: vi.fn(),
  addPoolAccount: vi.fn(),
  removePoolAccount: vi.fn(),
  togglePoolAccount: vi.fn(),
  getNotificationRules: vi.fn(),
  getNotificationRuleById: vi.fn(),
  createNotificationRule: vi.fn(),
  updateNotificationRule: vi.fn(),
  deleteNotificationRule: vi.fn(),
  getNotifications: vi.fn(),
  getOperators: vi.fn(),
  getOperatorById: vi.fn(),
  createOperator: vi.fn(),
  updateOperator: vi.fn(),
  deleteOperator: vi.fn(),
  getChats: vi.fn(),
  getChatById: vi.fn(),
  createChat: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
  updateChat: vi.fn(),
  getLineAccounts: vi.fn(),
  getEntryRoutes: vi.fn(),
  getEntryRouteById: vi.fn(),
  createEntryRoute: vi.fn(),
  updateEntryRoute: vi.fn(),
  deleteEntryRoute: vi.fn(),
  getEntryRouteFunnel: vi.fn(),
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
  getAccountHealthLogs: vi.fn(),
  getLatestRiskLevel: vi.fn(),
  getAccountMigrations: vi.fn(),
  getAccountMigrationById: vi.fn(),
  createAccountMigration: vi.fn(),
  updateAccountMigration: vi.fn(),
  jstNow: vi.fn(() => '2026-06-13T00:00:00.000+09:00'),
};

vi.mock('@line-crm/db', () => dbMocks);

const { automations } = await import('./automations.js');
const { autoReplies } = await import('./auto-replies.js');
const { trafficPools } = await import('./traffic-pools.js');
const { notifications } = await import('./notifications.js');
const { chats } = await import('./chats.js');
const { default: booking } = await import('./booking.js');
const { default: events } = await import('./events.js');
const { entryRoutes } = await import('./entry-routes.js');
const { conversions } = await import('./conversions.js');
const { calendar } = await import('./calendar.js');
const { health } = await import('./health.js');

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

function setupApp(role: StaffRole = 'staff', db: D1Database = {} as D1Database) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Tajima', role });
    c.env = { DB: db };
    await next();
  });
  app.route('/', automations);
  app.route('/', autoReplies);
  app.route('/', trafficPools);
  app.route('/', notifications);
  app.route('/', chats);
  app.route('/', booking);
  app.route('/', events);
  app.route('/', entryRoutes);
  app.route('/', conversions);
  app.route('/', calendar);
  app.route('/', health);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('management role guards', () => {
  test('staff cannot manage automation, auto-reply, or notification rule definitions', async () => {
    const app = setupApp('staff');
    const requests: Array<[string, string, RequestInit?]> = [
      ['POST', '/api/automations', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Welcome', eventType: 'friend_add', actions: [] }),
      }],
      ['PUT', '/api/automations/automation-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      }],
      ['DELETE', '/api/automations/automation-1'],
      ['POST', '/api/auto-replies', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: 'help', responseType: 'text', responseContent: 'hello' }),
      }],
      ['PUT', '/api/auto-replies/reply-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responseContent: 'updated' }),
      }],
      ['DELETE', '/api/auto-replies/reply-1'],
      ['POST', '/api/notifications/rules', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New booking', eventType: 'booking_created' }),
      }],
      ['PUT', '/api/notifications/rules/rule-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      }],
      ['DELETE', '/api/notifications/rules/rule-1'],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(dbMocks.createAutomation).not.toHaveBeenCalled();
    expect(dbMocks.updateAutomation).not.toHaveBeenCalled();
    expect(dbMocks.deleteAutomation).not.toHaveBeenCalled();
    expect(dbMocks.createAutoReply).not.toHaveBeenCalled();
    expect(dbMocks.updateAutoReply).not.toHaveBeenCalled();
    expect(dbMocks.deleteAutoReply).not.toHaveBeenCalled();
    expect(dbMocks.createNotificationRule).not.toHaveBeenCalled();
    expect(dbMocks.updateNotificationRule).not.toHaveBeenCalled();
    expect(dbMocks.deleteNotificationRule).not.toHaveBeenCalled();
  });

  test('staff cannot manage traffic pools or pool accounts', async () => {
    const app = setupApp('staff');
    const requests: Array<[string, string, RequestInit?]> = [
      ['POST', '/api/traffic-pools', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'main', name: 'Main', activeAccountId: 'acc-1' }),
      }],
      ['PUT', '/api/traffic-pools/pool-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      }],
      ['DELETE', '/api/traffic-pools/pool-1'],
      ['POST', '/api/traffic-pools/pool-1/accounts', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineAccountId: 'acc-2' }),
      }],
      ['PUT', '/api/traffic-pools/pool-1/accounts/pool-account-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      }],
      ['DELETE', '/api/traffic-pools/pool-1/accounts/pool-account-1'],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(dbMocks.createTrafficPool).not.toHaveBeenCalled();
    expect(dbMocks.updateTrafficPool).not.toHaveBeenCalled();
    expect(dbMocks.getTrafficPoolById).not.toHaveBeenCalled();
    expect(dbMocks.deleteTrafficPool).not.toHaveBeenCalled();
    expect(dbMocks.addPoolAccount).not.toHaveBeenCalled();
    expect(dbMocks.togglePoolAccount).not.toHaveBeenCalled();
    expect(dbMocks.removePoolAccount).not.toHaveBeenCalled();
  });

  test('staff cannot manage chat operators', async () => {
    const app = setupApp('staff');
    const requests: Array<[string, string, RequestInit?]> = [
      ['POST', '/api/operators', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Sato', email: 'sato@example.test' }),
      }],
      ['PUT', '/api/operators/operator-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      }],
      ['DELETE', '/api/operators/operator-1'],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(dbMocks.createOperator).not.toHaveBeenCalled();
    expect(dbMocks.updateOperator).not.toHaveBeenCalled();
    expect(dbMocks.getOperatorById).not.toHaveBeenCalled();
    expect(dbMocks.deleteOperator).not.toHaveBeenCalled();
  });

  test('staff cannot access booking or event admin routes', async () => {
    const db = { prepare: vi.fn() } as unknown as D1Database;
    const app = setupApp('staff', db);
    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/booking/admin/menus?account_id=acc-1'],
      ['POST', '/api/booking/admin/menus?account_id=acc-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Cut', duration_minutes: 30, base_price: 3000 }),
      }],
      ['PATCH', '/api/booking/admin/requests/booking-1?account_id=acc-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm' }),
      }],
      ['GET', '/api/events/admin/events?account_id=acc-1'],
      ['POST', '/api/events/admin/events?account_id=acc-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Seminar' }),
      }],
      ['POST', '/api/events/admin/events/event-1/bookings/booking-1/decide?account_id=acc-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm' }),
      }],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('staff cannot manage entry routes, conversion points, calendar connections, or account migrations', async () => {
    const db = { prepare: vi.fn() } as unknown as D1Database;
    const app = setupApp('staff', db);
    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/entry-routes'],
      ['POST', '/api/entry-routes', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refCode: 'launch', name: 'Launch route' }),
      }],
      ['PATCH', '/api/entry-routes/route-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      }],
      ['DELETE', '/api/entry-routes/route-1'],
      ['GET', '/api/entry-routes/route-1/funnel'],
      ['POST', '/api/conversions/points', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Purchase', eventType: 'purchase', value: 1000 }),
      }],
      ['DELETE', '/api/conversions/points/point-1'],
      ['POST', '/api/integrations/google-calendar/connect', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarId: 'primary', authType: 'api_key' }),
      }],
      ['DELETE', '/api/integrations/google-calendar/conn-1'],
      ['GET', '/api/accounts/acc-1/health'],
      ['GET', '/api/accounts/migrations'],
      ['POST', '/api/accounts/acc-1/migrate', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toAccountId: 'acc-2' }),
      }],
      ['GET', '/api/accounts/migrations/migration-1'],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(db.prepare).not.toHaveBeenCalled();
    expect(dbMocks.getEntryRoutes).not.toHaveBeenCalled();
    expect(dbMocks.createEntryRoute).not.toHaveBeenCalled();
    expect(dbMocks.updateEntryRoute).not.toHaveBeenCalled();
    expect(dbMocks.deleteEntryRoute).not.toHaveBeenCalled();
    expect(dbMocks.getEntryRouteFunnel).not.toHaveBeenCalled();
    expect(dbMocks.createConversionPoint).not.toHaveBeenCalled();
    expect(dbMocks.deleteConversionPoint).not.toHaveBeenCalled();
    expect(dbMocks.createCalendarConnection).not.toHaveBeenCalled();
    expect(dbMocks.deleteCalendarConnection).not.toHaveBeenCalled();
    expect(dbMocks.getLatestRiskLevel).not.toHaveBeenCalled();
    expect(dbMocks.getAccountMigrations).not.toHaveBeenCalled();
    expect(dbMocks.createAccountMigration).not.toHaveBeenCalled();
    expect(dbMocks.getAccountMigrationById).not.toHaveBeenCalled();
  });
});
