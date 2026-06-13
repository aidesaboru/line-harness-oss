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
  test('staff cannot read or manage automation, auto-reply, or notification rule definitions', async () => {
    const app = setupApp('staff');
    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/automations'],
      ['GET', '/api/automations/automation-1'],
      ['GET', '/api/automations/automation-1/logs'],
      ['POST', '/api/automations', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Welcome', eventType: 'friend_add', actions: [] }),
      }],
      ['PUT', '/api/automations/automation-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      }],
      ['DELETE', '/api/automations/automation-1'],
      ['GET', '/api/auto-replies'],
      ['GET', '/api/auto-replies/reply-1'],
      ['POST', '/api/auto-replies', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: 'help', responseType: 'text', responseContent: 'hello' }),
      }],
      ['PUT', '/api/auto-replies/reply-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responseContent: 'updated' }),
      }],
      ['DELETE', '/api/auto-replies/reply-1'],
      ['GET', '/api/notifications/rules'],
      ['GET', '/api/notifications/rules/rule-1'],
      ['GET', '/api/notifications'],
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

    expect(dbMocks.getAutomations).not.toHaveBeenCalled();
    expect(dbMocks.getAutomationById).not.toHaveBeenCalled();
    expect(dbMocks.getAutomationLogs).not.toHaveBeenCalled();
    expect(dbMocks.createAutomation).not.toHaveBeenCalled();
    expect(dbMocks.updateAutomation).not.toHaveBeenCalled();
    expect(dbMocks.deleteAutomation).not.toHaveBeenCalled();
    expect(dbMocks.getAutoReplies).not.toHaveBeenCalled();
    expect(dbMocks.getAutoReplyById).not.toHaveBeenCalled();
    expect(dbMocks.createAutoReply).not.toHaveBeenCalled();
    expect(dbMocks.updateAutoReply).not.toHaveBeenCalled();
    expect(dbMocks.deleteAutoReply).not.toHaveBeenCalled();
    expect(dbMocks.getNotificationRules).not.toHaveBeenCalled();
    expect(dbMocks.getNotificationRuleById).not.toHaveBeenCalled();
    expect(dbMocks.getNotifications).not.toHaveBeenCalled();
    expect(dbMocks.createNotificationRule).not.toHaveBeenCalled();
    expect(dbMocks.updateNotificationRule).not.toHaveBeenCalled();
    expect(dbMocks.deleteNotificationRule).not.toHaveBeenCalled();
  });

  test('staff cannot manage traffic pools or pool accounts', async () => {
    const app = setupApp('staff');
    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/traffic-pools'],
      ['POST', '/api/traffic-pools', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'main', name: 'Main', activeAccountId: 'acc-1' }),
      }],
      ['PUT', '/api/traffic-pools/pool-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      }],
      ['DELETE', '/api/traffic-pools/pool-1'],
      ['GET', '/api/traffic-pools/pool-1/accounts'],
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

    expect(dbMocks.getTrafficPools).not.toHaveBeenCalled();
    expect(dbMocks.createTrafficPool).not.toHaveBeenCalled();
    expect(dbMocks.updateTrafficPool).not.toHaveBeenCalled();
    expect(dbMocks.getTrafficPoolById).not.toHaveBeenCalled();
    expect(dbMocks.deleteTrafficPool).not.toHaveBeenCalled();
    expect(dbMocks.getPoolAccounts).not.toHaveBeenCalled();
    expect(dbMocks.addPoolAccount).not.toHaveBeenCalled();
    expect(dbMocks.togglePoolAccount).not.toHaveBeenCalled();
    expect(dbMocks.removePoolAccount).not.toHaveBeenCalled();
  });

  test('traffic pool management rejects malformed payloads before DB writes', async () => {
    const app = setupApp('admin');
    const malformedCreate = await app.request('/api/traffic-pools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    const unsafeSlug = await app.request('/api/traffic-pools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'Main Pool', name: 'Main', activeAccountId: 'acc-1' }),
    });
    const malformedUpdate = await app.request('/api/traffic-pools/pool-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: 'false' }),
    });
    const emptyUpdate = await app.request('/api/traffic-pools/pool-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const malformedAccount = await app.request('/api/traffic-pools/pool-1/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineAccountId: 'bad account' }),
    });
    const malformedToggle = await app.request('/api/traffic-pools/pool-1/accounts/pool-account-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: 1 }),
    });

    expect(malformedCreate.status).toBe(400);
    expect(unsafeSlug.status).toBe(400);
    expect(malformedUpdate.status).toBe(400);
    expect(emptyUpdate.status).toBe(400);
    expect(malformedAccount.status).toBe(400);
    expect(malformedToggle.status).toBe(400);
    expect(dbMocks.createTrafficPool).not.toHaveBeenCalled();
    expect(dbMocks.updateTrafficPool).not.toHaveBeenCalled();
    expect(dbMocks.addPoolAccount).not.toHaveBeenCalled();
    expect(dbMocks.togglePoolAccount).not.toHaveBeenCalled();
  });

  test('traffic pool management trims valid payloads before DB writes', async () => {
    const pool = {
      id: 'pool-1',
      slug: 'main-pool',
      name: 'Main',
      active_account_id: 'acc-1',
      account_name: 'Account',
      liff_id: null,
      login_channel_id: null,
      login_channel_secret: null,
      channel_access_token: null,
      channel_id: null,
      is_active: 1,
      created_at: '2026-06-13T00:00:00.000+09:00',
      updated_at: '2026-06-13T00:00:00.000+09:00',
    };
    dbMocks.createTrafficPool.mockResolvedValue(pool);
    dbMocks.updateTrafficPool.mockResolvedValue({ ...pool, name: 'Renamed' });
    dbMocks.addPoolAccount.mockResolvedValue({
      id: 'pool-account-1',
      pool_id: 'pool-1',
      line_account_id: 'acc-2',
      is_active: 1,
      created_at: '2026-06-13T00:00:00.000+09:00',
    });
    dbMocks.togglePoolAccount.mockResolvedValue({
      id: 'pool-account-1',
      pool_id: 'pool-1',
      line_account_id: 'acc-2',
      is_active: 0,
      created_at: '2026-06-13T00:00:00.000+09:00',
    });

    const app = setupApp('admin');
    await app.request('/api/traffic-pools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: ' main-pool ', name: ' Main ', activeAccountId: ' acc-1 ' }),
    });
    await app.request('/api/traffic-pools/pool-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ' Renamed ', activeAccountId: ' acc-2 ', isActive: true }),
    });
    await app.request('/api/traffic-pools/pool-1/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineAccountId: ' acc-2 ' }),
    });
    await app.request('/api/traffic-pools/pool-1/accounts/pool-account-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: false }),
    });

    expect(dbMocks.createTrafficPool).toHaveBeenCalledWith({} as D1Database, {
      slug: 'main-pool',
      name: 'Main',
      activeAccountId: 'acc-1',
    });
    expect(dbMocks.updateTrafficPool).toHaveBeenCalledWith({} as D1Database, 'pool-1', {
      name: 'Renamed',
      activeAccountId: 'acc-2',
      isActive: true,
    });
    expect(dbMocks.addPoolAccount).toHaveBeenCalledWith({} as D1Database, 'pool-1', 'acc-2');
    expect(dbMocks.togglePoolAccount).toHaveBeenCalledWith({} as D1Database, 'pool-account-1', false);
  });

  test('staff cannot manage chat operators', async () => {
    const app = setupApp('staff');
    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/operators'],
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

    expect(dbMocks.getOperators).not.toHaveBeenCalled();
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
      ['GET', '/api/conversions/points'],
      ['POST', '/api/conversions/points', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Purchase', eventType: 'purchase', value: 1000 }),
      }],
      ['DELETE', '/api/conversions/points/point-1'],
      ['POST', '/api/integrations/google-calendar/connect', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarId: 'primary', authType: 'api_key' }),
      }],
      ['GET', '/api/integrations/google-calendar'],
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
    expect(dbMocks.getConversionPoints).not.toHaveBeenCalled();
    expect(dbMocks.createConversionPoint).not.toHaveBeenCalled();
    expect(dbMocks.deleteConversionPoint).not.toHaveBeenCalled();
    expect(dbMocks.getCalendarConnections).not.toHaveBeenCalled();
    expect(dbMocks.createCalendarConnection).not.toHaveBeenCalled();
    expect(dbMocks.deleteCalendarConnection).not.toHaveBeenCalled();
    expect(dbMocks.getLatestRiskLevel).not.toHaveBeenCalled();
    expect(dbMocks.getAccountMigrations).not.toHaveBeenCalled();
    expect(dbMocks.createAccountMigration).not.toHaveBeenCalled();
    expect(dbMocks.getAccountMigrationById).not.toHaveBeenCalled();
  });
});

describe('account health and migration payload validation', () => {
  test('owner account health and migration routes reject unsafe input before DB helpers', async () => {
    const db = { prepare: vi.fn() } as unknown as D1Database;
    const app = setupApp('owner', db);
    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/accounts/bad%20account/health'],
      ['POST', '/api/accounts/bad%20account/migrate', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toAccountId: 'acc-2' }),
      }],
      ['POST', '/api/accounts/acc-1/migrate', {
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }],
      ['POST', '/api/accounts/acc-1/migrate', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }],
      ['POST', '/api/accounts/acc-1/migrate', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toAccountId: 'bad account' }),
      }],
      ['GET', '/api/accounts/migrations/bad%20migration'],
    ];

    for (const [method, path, init] of requests) {
      vi.clearAllMocks();
      const res = await app.request(path, { ...init, method });

      expect(res.status, `${method} ${path}`).toBe(400);
      expect(db.prepare).not.toHaveBeenCalled();
      expect(dbMocks.getLatestRiskLevel).not.toHaveBeenCalled();
      expect(dbMocks.getAccountHealthLogs).not.toHaveBeenCalled();
      expect(dbMocks.createAccountMigration).not.toHaveBeenCalled();
      expect(dbMocks.updateAccountMigration).not.toHaveBeenCalled();
      expect(dbMocks.getAccountMigrationById).not.toHaveBeenCalled();
    }
  });

  test('owner account health and migration routes trim valid IDs before DB helpers', async () => {
    const countFirst = vi.fn().mockResolvedValue({ count: 7 });
    const db = {
      prepare: vi.fn(() => ({ first: countFirst })),
    } as unknown as D1Database;
    const app = setupApp('owner', db);
    dbMocks.getLatestRiskLevel.mockResolvedValue('normal');
    dbMocks.getAccountHealthLogs.mockResolvedValue([
      {
        id: 'log-1',
        error_code: null,
        error_count: 0,
        check_period: '24h',
        risk_level: 'normal',
        created_at: '2026-06-13T10:00:00.000',
      },
    ]);
    dbMocks.createAccountMigration.mockResolvedValue({
      id: 'migration-1',
      from_account_id: 'acc-1',
      to_account_id: 'acc-2',
      status: 'pending',
      migrated_count: 0,
      total_count: 7,
      created_at: '2026-06-13T10:00:00.000',
      completed_at: null,
    });
    dbMocks.updateAccountMigration.mockResolvedValue(undefined);
    dbMocks.getAccountMigrationById.mockResolvedValue({
      id: 'migration-1',
      from_account_id: 'acc-1',
      to_account_id: 'acc-2',
      status: 'in_progress',
      migrated_count: 0,
      total_count: 7,
      created_at: '2026-06-13T10:00:00.000',
      completed_at: null,
    });

    const healthRes = await app.request('/api/accounts/%20acc-1%20/health');
    expect(healthRes.status).toBe(200);
    expect(dbMocks.getLatestRiskLevel).toHaveBeenCalledWith(db, 'acc-1');
    expect(dbMocks.getAccountHealthLogs).toHaveBeenCalledWith(db, 'acc-1');

    const migrateRes = await app.request('/api/accounts/%20acc-1%20/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toAccountId: ' acc-2 ' }),
    });
    expect(migrateRes.status).toBe(201);
    expect(dbMocks.createAccountMigration).toHaveBeenCalledWith(db, {
      fromAccountId: 'acc-1',
      toAccountId: 'acc-2',
      totalCount: 7,
    });
    expect(dbMocks.updateAccountMigration).toHaveBeenCalledWith(db, 'migration-1', {
      status: 'in_progress',
    });

    const migrationRes = await app.request('/api/accounts/migrations/%20migration-1%20');
    expect(migrationRes.status).toBe(200);
    expect(dbMocks.getAccountMigrationById).toHaveBeenCalledWith(db, 'migration-1');
  });
});

describe('conversion point payload validation', () => {
  const conversionPointRow = {
    id: 'point-1',
    name: 'Purchase',
    event_type: 'purchase',
    value: 9800.5,
    created_at: '2026-06-13T10:00:00.000',
  };

  test('owner conversion point create rejects malformed or invalid payloads before DB writes', async () => {
    const app = setupApp('owner');
    const requests: BodyInit[] = [
      '{',
      JSON.stringify([]),
      JSON.stringify({ name: 123, eventType: 'purchase' }),
      JSON.stringify({ name: 'x'.repeat(121), eventType: 'purchase' }),
      JSON.stringify({ name: 'Purchase', eventType: 'bad event' }),
      JSON.stringify({ name: 'Purchase', eventType: 'purchase', value: '9800' }),
      JSON.stringify({ name: 'Purchase', eventType: 'purchase', value: -1 }),
      JSON.stringify({ name: 'Purchase', eventType: 'purchase', value: 1_000_000_000_001 }),
    ];

    for (const body of requests) {
      const res = await app.request('/api/conversions/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(400);
    }

    expect(dbMocks.createConversionPoint).not.toHaveBeenCalled();
  });

  test('owner conversion point create trims valid payloads before DB writes', async () => {
    dbMocks.createConversionPoint.mockResolvedValue(conversionPointRow);
    const app = setupApp('owner');

    const res = await app.request('/api/conversions/points', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ' Purchase ',
        eventType: ' purchase ',
        value: 9800.5,
      }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createConversionPoint).toHaveBeenCalledWith(expect.anything(), {
      name: 'Purchase',
      eventType: 'purchase',
      value: 9800.5,
    });
  });

  test('owner conversion point create normalizes missing value before DB writes', async () => {
    dbMocks.createConversionPoint.mockResolvedValue({ ...conversionPointRow, value: null });
    const app = setupApp('owner');

    const res = await app.request('/api/conversions/points', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Form submit',
        eventType: 'form_submit',
      }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createConversionPoint).toHaveBeenCalledWith(expect.anything(), {
      name: 'Form submit',
      eventType: 'form_submit',
      value: null,
    });
  });
});

describe('entry route payload validation', () => {
  const entryRouteRow = {
    id: 'route-1',
    ref_code: 'launch_2026',
    name: 'Launch route',
    tag_id: 'tag-1',
    scenario_id: null,
    redirect_url: null,
    pool_id: 'pool-1',
    intro_template_id: 'tmpl-1',
    run_account_friend_add_scenarios: 0,
    is_active: 1,
    created_at: '2026-06-13T10:00:00.000',
    updated_at: '2026-06-13T10:00:00.000',
  };

  test('owner entry route create/update rejects malformed or invalid payloads before DB writes', async () => {
    const app = setupApp('owner');
    const requests: Array<[string, string, BodyInit]> = [
      ['POST', '/api/entry-routes', '{'],
      ['POST', '/api/entry-routes', JSON.stringify({ refCode: 'bad/ref', name: 'Bad route' })],
      ['POST', '/api/entry-routes', JSON.stringify({ refCode: 'launch', name: 'Bad route', redirectUrl: 'javascript:alert(1)' })],
      ['POST', '/api/entry-routes', JSON.stringify({ refCode: 'launch', name: 'Bad route', isActive: 'yes' })],
      ['PATCH', '/api/entry-routes/route-1', '{'],
      ['PATCH', '/api/entry-routes/route-1', JSON.stringify({})],
      ['PATCH', '/api/entry-routes/route-1', JSON.stringify({ refCode: 'xh:secret' })],
      ['PATCH', '/api/entry-routes/route-1', JSON.stringify({ poolId: 'bad id' })],
      ['PATCH', '/api/entry-routes/route-1', JSON.stringify({ redirectUrl: 'ftp://example.com' })],
      ['PATCH', '/api/entry-routes/route-1', JSON.stringify({ runAccountFriendAddScenarios: 'false' })],
    ];

    for (const [method, path, body] of requests) {
      const res = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status, `${method} ${path}`).toBe(400);
    }

    expect(dbMocks.createEntryRoute).not.toHaveBeenCalled();
    expect(dbMocks.updateEntryRoute).not.toHaveBeenCalled();
  });

  test('owner entry route create trims and nulls valid payloads before DB writes', async () => {
    dbMocks.createEntryRoute.mockResolvedValue(entryRouteRow);
    const app = setupApp('owner');

    const res = await app.request('/api/entry-routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refCode: ' launch_2026 ',
        name: ' Launch route ',
        tagId: ' tag-1 ',
        scenarioId: ' ',
        redirectUrl: ' https://example.com/welcome ',
        poolId: ' pool-1 ',
        introTemplateId: ' tmpl-1 ',
        runAccountFriendAddScenarios: false,
        isActive: true,
      }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createEntryRoute).toHaveBeenCalledWith(expect.anything(), {
      refCode: 'launch_2026',
      name: 'Launch route',
      tagId: 'tag-1',
      scenarioId: null,
      redirectUrl: 'https://example.com/welcome',
      poolId: 'pool-1',
      introTemplateId: 'tmpl-1',
      runAccountFriendAddScenarios: false,
      isActive: true,
    });
  });

  test('owner entry route update trims and nulls valid payloads before DB writes', async () => {
    dbMocks.updateEntryRoute.mockResolvedValue({ ...entryRouteRow, ref_code: 'sale_2026' });
    const app = setupApp('owner');

    const res = await app.request('/api/entry-routes/route-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refCode: ' sale_2026 ',
        name: ' Sale route ',
        tagId: null,
        scenarioId: ' scenario-1 ',
        redirectUrl: ' ',
        poolId: ' pool-1 ',
        introTemplateId: ' ',
        runAccountFriendAddScenarios: false,
        isActive: false,
      }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.updateEntryRoute).toHaveBeenCalledWith(expect.anything(), 'route-1', {
      refCode: 'sale_2026',
      name: 'Sale route',
      tagId: null,
      scenarioId: 'scenario-1',
      redirectUrl: null,
      poolId: 'pool-1',
      introTemplateId: null,
      runAccountFriendAddScenarios: false,
      isActive: false,
    });
  });
});
