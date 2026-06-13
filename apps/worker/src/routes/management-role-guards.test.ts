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
  jstNow: vi.fn(() => '2026-06-13T00:00:00.000+09:00'),
};

vi.mock('@line-crm/db', () => dbMocks);

const { automations } = await import('./automations.js');
const { autoReplies } = await import('./auto-replies.js');
const { trafficPools } = await import('./traffic-pools.js');
const { notifications } = await import('./notifications.js');
const { chats } = await import('./chats.js');

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

function setupApp(role: StaffRole = 'staff') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Tajima', role });
    c.env = { DB: {} as D1Database };
    await next();
  });
  app.route('/', automations);
  app.route('/', autoReplies);
  app.route('/', trafficPools);
  app.route('/', notifications);
  app.route('/', chats);
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
});
