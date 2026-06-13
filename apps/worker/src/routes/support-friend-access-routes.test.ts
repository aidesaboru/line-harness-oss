import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getScoringRules: vi.fn(),
  getScoringRuleById: vi.fn(),
  createScoringRule: vi.fn(),
  updateScoringRule: vi.fn(),
  deleteScoringRule: vi.fn(),
  getFriendScore: vi.fn(),
  getFriendScoreHistory: vi.fn(),
  addScore: vi.fn(),
  getReminders: vi.fn(),
  getReminderById: vi.fn(),
  createReminder: vi.fn(),
  updateReminder: vi.fn(),
  deleteReminder: vi.fn(),
  getReminderSteps: vi.fn(),
  createReminderStep: vi.fn(),
  deleteReminderStep: vi.fn(),
  enrollFriendInReminder: vi.fn(),
  getFriendReminders: vi.fn(),
  cancelFriendReminder: vi.fn(),
  getFriendById: vi.fn(),
  getLineAccountById: vi.fn(),
};

const lineClientMethods = {
  linkRichMenuToUser: vi.fn(),
  unlinkRichMenuFromUser: vi.fn(),
  getRichMenuIdOfUser: vi.fn(),
  getDefaultRichMenuId: vi.fn(),
  getRichMenuList: vi.fn(),
};

const lineClientConstructor = vi.fn(() => lineClientMethods);

vi.mock('@line-crm/db', () => dbMocks);
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: lineClientConstructor,
}));

const { scoring } = await import('./scoring.js');
const { reminders } = await import('./reminders.js');
const { richMenus } = await import('./rich-menus.js');

type TestEnv = {
  Variables: { staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' } };
  Bindings: {
    DB: D1Database;
    LINE_CHANNEL_ACCESS_TOKEN: string;
  };
};

const friends = [
  { id: 'friend-visible', line_user_id: 'U-visible', line_account_id: 'acc-1' },
  { id: 'friend-hidden', line_user_id: 'U-hidden', line_account_id: 'acc-1' },
];

function makeDb(state: {
  visibleFriendIds?: string[];
  reminderFriendById?: Record<string, string>;
}) {
  const visible = new Set(state.visibleFriendIds ?? []);
  const reminderFriendById = state.reminderFriendById ?? {};

  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>() {
          if (sql.startsWith('SELECT 1 AS ok WHERE')) {
            const [friendId] = bound as [string];
            return (visible.has(friendId) ? { ok: 1 } : null) as T | null;
          }
          if (sql.includes('SELECT friend_id FROM friend_reminders')) {
            const [reminderId] = bound as [string];
            const friendId = reminderFriendById[reminderId];
            return (friendId ? { friend_id: friendId } : null) as T | null;
          }
          return null as T | null;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function setupApp(db: D1Database, role: 'owner' | 'admin' | 'staff' = 'staff') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '田島', role });
    c.env = {
      DB: db,
      LINE_CHANNEL_ACCESS_TOKEN: 'fallback-token',
    };
    await next();
  });
  app.route('/', scoring);
  app.route('/', reminders);
  app.route('/', richMenus);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getFriendScore.mockResolvedValue(42);
  dbMocks.getFriendScoreHistory.mockResolvedValue([
    {
      id: 'history-1',
      scoring_rule_id: 'rule-1',
      score_change: 5,
      reason: 'manual',
      created_at: '2026-06-12T10:00:00.000',
    },
  ]);
  dbMocks.addScore.mockResolvedValue(undefined);
  dbMocks.enrollFriendInReminder.mockResolvedValue({
    id: 'friend-reminder-visible',
    friend_id: 'friend-visible',
    reminder_id: 'reminder-1',
    target_date: '2026-06-13',
    status: 'active',
  });
  dbMocks.getFriendReminders.mockResolvedValue([
    {
      id: 'friend-reminder-visible',
      friend_id: 'friend-visible',
      reminder_id: 'reminder-1',
      target_date: '2026-06-13',
      status: 'active',
      created_at: '2026-06-12T10:00:00.000',
    },
  ]);
  dbMocks.cancelFriendReminder.mockResolvedValue(undefined);
  dbMocks.getFriendById.mockImplementation(async (_db: D1Database, id: string) =>
    friends.find((friend) => friend.id === id) ?? null,
  );
  dbMocks.getLineAccountById.mockResolvedValue({ channel_access_token: 'account-token' });
  lineClientConstructor.mockImplementation(() => lineClientMethods);
  lineClientMethods.getRichMenuIdOfUser.mockResolvedValue({ richMenuId: 'menu-1' });
  lineClientMethods.getDefaultRichMenuId.mockResolvedValue(null);
  lineClientMethods.getRichMenuList.mockResolvedValue({ richmenus: [{ richMenuId: 'menu-1', name: 'VIP Menu' }] });
});

describe('friend-scoped support visibility guards', () => {
  test('staff cannot read or manage scoring rule or reminder definitions', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });
    const app = setupApp(db, 'staff');
    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/scoring-rules'],
      ['GET', '/api/scoring-rules/rule-1'],
      ['POST', '/api/scoring-rules', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hot lead', eventType: 'manual', scoreValue: 10 }),
      }],
      ['PUT', '/api/scoring-rules/rule-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scoreValue: 20 }),
      }],
      ['DELETE', '/api/scoring-rules/rule-1'],
      ['GET', '/api/reminders'],
      ['GET', '/api/reminders/reminder-1'],
      ['POST', '/api/reminders', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Follow up' }),
      }],
      ['PUT', '/api/reminders/reminder-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: false }),
      }],
      ['DELETE', '/api/reminders/reminder-1'],
      ['POST', '/api/reminders/reminder-1/steps', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offsetMinutes: 10, messageType: 'text', messageContent: 'ping' }),
      }],
      ['DELETE', '/api/reminders/reminder-1/steps/step-1'],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(dbMocks.getScoringRules).not.toHaveBeenCalled();
    expect(dbMocks.getScoringRuleById).not.toHaveBeenCalled();
    expect(dbMocks.createScoringRule).not.toHaveBeenCalled();
    expect(dbMocks.updateScoringRule).not.toHaveBeenCalled();
    expect(dbMocks.deleteScoringRule).not.toHaveBeenCalled();
    expect(dbMocks.getReminders).not.toHaveBeenCalled();
    expect(dbMocks.getReminderById).not.toHaveBeenCalled();
    expect(dbMocks.getReminderSteps).not.toHaveBeenCalled();
    expect(dbMocks.createReminder).not.toHaveBeenCalled();
    expect(dbMocks.updateReminder).not.toHaveBeenCalled();
    expect(dbMocks.deleteReminder).not.toHaveBeenCalled();
    expect(dbMocks.createReminderStep).not.toHaveBeenCalled();
    expect(dbMocks.deleteReminderStep).not.toHaveBeenCalled();
  });

  test('staff cannot read a hidden friend score', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/friend-hidden/score');

    expect(res.status).toBe(404);
    expect(dbMocks.getFriendScore).not.toHaveBeenCalled();
    expect(dbMocks.getFriendScoreHistory).not.toHaveBeenCalled();
  });

  test('owner can read friend score without staff support-case scope', async () => {
    const db = makeDb({ visibleFriendIds: [] });

    const res = await setupApp(db, 'owner').request('/api/friends/friend-hidden/score');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { friendId: string; currentScore: number } };
    expect(body.data).toMatchObject({ friendId: 'friend-hidden', currentScore: 42 });
  });

  test('staff cannot add score to a hidden friend', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/friend-hidden/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scoreChange: 5, reason: 'hidden friend update' }),
    });

    expect(res.status).toBe(404);
    expect(dbMocks.addScore).not.toHaveBeenCalled();
  });

  test('staff cannot enroll a hidden friend in a reminder', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/reminders/reminder-1/enroll/friend-hidden', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetDate: '2026-06-13' }),
    });

    expect(res.status).toBe(404);
    expect(dbMocks.enrollFriendInReminder).not.toHaveBeenCalled();
  });

  test('staff cannot list hidden friend reminders', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/friend-hidden/reminders');

    expect(res.status).toBe(404);
    expect(dbMocks.getFriendReminders).not.toHaveBeenCalled();
  });

  test('staff cannot cancel hidden friend reminder by enrollment id', async () => {
    const db = makeDb({
      visibleFriendIds: ['friend-visible'],
      reminderFriendById: { 'friend-reminder-hidden': 'friend-hidden' },
    });

    const res = await setupApp(db, 'staff').request('/api/friend-reminders/friend-reminder-hidden', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(dbMocks.cancelFriendReminder).not.toHaveBeenCalled();
  });

  test('staff can cancel visible friend reminder by enrollment id', async () => {
    const db = makeDb({
      visibleFriendIds: ['friend-visible'],
      reminderFriendById: { 'friend-reminder-visible': 'friend-visible' },
    });

    const res = await setupApp(db, 'staff').request('/api/friend-reminders/friend-reminder-visible', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(dbMocks.cancelFriendReminder).toHaveBeenCalledWith(db, 'friend-reminder-visible');
  });

  test('staff cannot manage LINE rich menu catalog routes', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });
    const app = setupApp(db, 'staff');
    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/rich-menus'],
      ['POST', '/api/rich-menus', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'VIP' }),
      }],
      ['POST', '/api/rich-menus/menu-1/default'],
      ['POST', '/api/rich-menus/menu-1/image', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: 'data:image/png;base64,AAAA' }),
      }],
      ['DELETE', '/api/rich-menus/menu-1'],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(lineClientConstructor).not.toHaveBeenCalled();
  });

  test('staff cannot read or mutate hidden friend rich menu state', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });
    const app = setupApp(db, 'staff');

    const getRes = await app.request('/api/friends/friend-hidden/rich-menu');
    const postRes = await app.request('/api/friends/friend-hidden/rich-menu', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ richMenuId: 'menu-1' }),
    });
    const deleteRes = await app.request('/api/friends/friend-hidden/rich-menu', { method: 'DELETE' });

    expect(getRes.status).toBe(404);
    expect(postRes.status).toBe(404);
    expect(deleteRes.status).toBe(404);
    expect(dbMocks.getFriendById).not.toHaveBeenCalled();
    expect(lineClientConstructor).not.toHaveBeenCalled();
  });

  test('staff can read visible friend rich menu state', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });

    const res = await setupApp(db, 'staff').request('/api/friends/friend-visible/rich-menu');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string | null; name: string | null; isDefault: boolean } };
    expect(body.data).toEqual({ id: 'menu-1', name: 'VIP Menu', isDefault: false });
    expect(dbMocks.getFriendById).toHaveBeenCalledWith(db, 'friend-visible');
    expect(lineClientMethods.getRichMenuIdOfUser).toHaveBeenCalledWith('U-visible');
  });
});
