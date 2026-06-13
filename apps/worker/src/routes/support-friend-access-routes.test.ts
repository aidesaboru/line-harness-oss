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
  createRichMenu: vi.fn(),
  deleteRichMenu: vi.fn(),
  setDefaultRichMenu: vi.fn(),
  uploadRichMenuImage: vi.fn(),
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

function loggedText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join(' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.createScoringRule.mockResolvedValue({
    id: 'rule-1',
    name: 'Hot lead',
    event_type: 'url_click',
    score_value: 10,
    is_active: 1,
    created_at: '2026-06-12T10:00:00.000',
    updated_at: '2026-06-12T10:00:00.000',
  });
  dbMocks.updateScoringRule.mockResolvedValue(undefined);
  dbMocks.getScoringRuleById.mockResolvedValue({
    id: 'rule-1',
    name: 'Hot lead',
    event_type: 'url_click',
    score_value: 10,
    is_active: 1,
    created_at: '2026-06-12T10:00:00.000',
    updated_at: '2026-06-12T10:00:00.000',
  });
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
  dbMocks.createReminder.mockResolvedValue({
    id: 'reminder-1',
    name: 'Follow up',
    description: 'Ping later',
    is_active: 1,
    created_at: '2026-06-12T10:00:00.000',
    updated_at: '2026-06-12T10:00:00.000',
  });
  dbMocks.updateReminder.mockResolvedValue(undefined);
  dbMocks.getReminderById.mockResolvedValue({
    id: 'reminder-1',
    name: 'Follow up',
    description: 'Ping later',
    is_active: 1,
    created_at: '2026-06-12T10:00:00.000',
    updated_at: '2026-06-12T10:00:00.000',
  });
  dbMocks.createReminderStep.mockResolvedValue({
    id: 'step-1',
    reminder_id: 'reminder-1',
    offset_minutes: -60,
    message_type: 'text',
    message_content: 'ping',
    created_at: '2026-06-12T10:00:00.000',
  });
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

  test('owner scoring and reminder definition payloads reject invalid input before DB helpers', async () => {
    const requests: Array<[string, string, string]> = [
      ['POST', '/api/scoring-rules', '{'],
      ['POST', '/api/scoring-rules', JSON.stringify({ name: ' ', eventType: 'url_click', scoreValue: 10 })],
      ['POST', '/api/scoring-rules', JSON.stringify({ name: 'Hot', eventType: 'bad event', scoreValue: 10 })],
      ['POST', '/api/scoring-rules', JSON.stringify({ name: 'Hot', eventType: 'url_click', scoreValue: 1.5 })],
      ['PUT', '/api/scoring-rules/rule-1', JSON.stringify({ isActive: 'yes' })],
      ['POST', '/api/reminders', '{'],
      ['POST', '/api/reminders', JSON.stringify({ name: ' ', description: 'Ping' })],
      ['POST', '/api/reminders', JSON.stringify({ name: 'Follow up', lineAccountId: 'bad account' })],
      ['PUT', '/api/reminders/reminder-1', JSON.stringify({ isActive: 'yes' })],
      ['POST', '/api/reminders/reminder-1/steps', JSON.stringify({
        offsetMinutes: 1.5,
        messageType: 'text',
        messageContent: 'ping',
      })],
      ['POST', '/api/reminders/reminder-1/steps', JSON.stringify({
        offsetMinutes: -60,
        messageType: 'video',
        messageContent: 'ping',
      })],
      ['POST', '/api/reminders/reminder-1/steps', JSON.stringify({
        offsetMinutes: -60,
        messageType: 'flex',
        messageContent: '{',
      })],
    ];

    for (const [method, path, body] of requests) {
      vi.clearAllMocks();
      const db = makeDb({ visibleFriendIds: ['friend-visible'] });

      const res = await setupApp(db, 'owner').request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(res.status, `${method} ${path} ${body}`).toBe(400);
      expect(dbMocks.createScoringRule).not.toHaveBeenCalled();
      expect(dbMocks.updateScoringRule).not.toHaveBeenCalled();
      expect(dbMocks.createReminder).not.toHaveBeenCalled();
      expect(dbMocks.updateReminder).not.toHaveBeenCalled();
      expect(dbMocks.createReminderStep).not.toHaveBeenCalled();
    }
  });

  test('owner scoring and reminder definition payloads trim valid values before DB helpers', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });
    const app = setupApp(db, 'owner');

    const scoringCreate = await app.request('/api/scoring-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ' Hot lead ', eventType: ' url_click ', scoreValue: 10 }),
    });
    expect(scoringCreate.status).toBe(201);
    expect(dbMocks.createScoringRule).toHaveBeenCalledWith(db, {
      name: 'Hot lead',
      eventType: 'url_click',
      scoreValue: 10,
    });

    const scoringUpdate = await app.request('/api/scoring-rules/%20rule-1%20', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: ' manual ', isActive: 0 }),
    });
    expect(scoringUpdate.status).toBe(200);
    expect(dbMocks.updateScoringRule).toHaveBeenCalledWith(db, 'rule-1', {
      eventType: 'manual',
      isActive: false,
    });

    const reminderCreate = await app.request('/api/reminders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ' Follow up ',
        description: ' Ping later ',
        lineAccountId: ' acc-1 ',
      }),
    });
    expect(reminderCreate.status).toBe(201);
    expect(dbMocks.createReminder).toHaveBeenCalledWith(db, {
      name: 'Follow up',
      description: 'Ping later',
    });

    const reminderUpdate = await app.request('/api/reminders/%20reminder-1%20', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ' Renewal ', description: ' ', isActive: 1 }),
    });
    expect(reminderUpdate.status).toBe(200);
    expect(dbMocks.updateReminder).toHaveBeenCalledWith(db, 'reminder-1', {
      name: 'Renewal',
      description: null,
      isActive: true,
    });

    const stepCreate = await app.request('/api/reminders/%20reminder-1%20/steps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offsetMinutes: -60,
        messageType: ' text ',
        messageContent: ' ping ',
      }),
    });
    expect(stepCreate.status).toBe(201);
    expect(dbMocks.createReminderStep).toHaveBeenCalledWith(db, {
      reminderId: 'reminder-1',
      offsetMinutes: -60,
      messageType: 'text',
      messageContent: 'ping',
    });
  });

  test('visible friend score and reminder enrollment payloads reject invalid input before DB helpers', async () => {
    const requests: Array<[string, string, string]> = [
      ['POST', '/api/friends/friend-visible/score', '{'],
      ['POST', '/api/friends/friend-visible/score', JSON.stringify({ scoreChange: 1.5 })],
      ['POST', '/api/friends/friend-visible/score', JSON.stringify({
        scoreChange: 5,
        reason: 'x'.repeat(1001),
      })],
      ['POST', '/api/reminders/reminder-1/enroll/friend-visible', JSON.stringify({ targetDate: '2026-02-31' })],
      ['POST', '/api/reminders/reminder-1/enroll/friend-visible', JSON.stringify({ targetDate: 'bad date' })],
    ];

    for (const [method, path, body] of requests) {
      vi.clearAllMocks();
      const db = makeDb({ visibleFriendIds: ['friend-visible'] });

      const res = await setupApp(db, 'staff').request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(res.status, `${method} ${path} ${body}`).toBe(400);
      expect(dbMocks.addScore).not.toHaveBeenCalled();
      expect(dbMocks.enrollFriendInReminder).not.toHaveBeenCalled();
    }
  });

  test('visible friend score and reminder enrollment payloads trim valid values', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });
    const app = setupApp(db, 'staff');

    const scoreRes = await app.request('/api/friends/%20friend-visible%20/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scoreChange: -5, reason: ' manual update ' }),
    });

    expect(scoreRes.status).toBe(201);
    expect(dbMocks.addScore).toHaveBeenCalledWith(db, {
      friendId: 'friend-visible',
      scoreChange: -5,
      reason: 'manual update',
    });

    const enrollRes = await app.request('/api/reminders/%20reminder-1%20/enroll/%20friend-visible%20', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetDate: ' 2026-06-13 ' }),
    });

    expect(enrollRes.status).toBe(201);
    expect(dbMocks.enrollFriendInReminder).toHaveBeenCalledWith(db, {
      friendId: 'friend-visible',
      reminderId: 'reminder-1',
      targetDate: '2026-06-13',
    });
  });

  test('scoring rule failure logs only the error kind', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });
    dbMocks.createScoringRule.mockRejectedValueOnce(
      new Error('scoring rule secret account-token rule-1 Hot lead manual reason'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'owner').request('/api/scoring-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hot lead', eventType: 'manual', scoreValue: 10 }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/scoring-rules error: Error');
      expect(logged).not.toContain('scoring rule secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('rule-1');
      expect(logged).not.toContain('Hot lead');
      expect(logged).not.toContain('manual reason');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('friend score failure does not leak raw exception into logs or response', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });
    dbMocks.addScore.mockRejectedValueOnce(
      new Error('friend score secret account-token friend-visible U-visible manual update'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'staff').request('/api/friends/friend-visible/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scoreChange: 5, reason: 'manual update account-token' }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/friends/:id/score error: Error');
      expect(logged).not.toContain('friend score secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('friend-visible');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('manual update');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('friend reminder enrollment failure does not leak raw exception into logs or response', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });
    dbMocks.enrollFriendInReminder.mockRejectedValueOnce(
      new Error('reminder secret account-token friend-visible reminder-1 targetDate 2026-06-13'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'staff').request('/api/reminders/reminder-1/enroll/friend-visible', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDate: '2026-06-13' }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/reminders/:id/enroll/:friendId error: Error');
      expect(logged).not.toContain('reminder secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('friend-visible');
      expect(logged).not.toContain('reminder-1');
      expect(logged).not.toContain('targetDate');
      expect(logged).not.toContain('2026-06-13');
    } finally {
      errorSpy.mockRestore();
    }
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

  test('rich menu catalog failure logs only the error kind', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });
    lineClientMethods.getRichMenuList.mockRejectedValueOnce(
      new Error('rich menu catalog secret account-token acc-1 richmenu-1 raw-body'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'owner').request('/api/rich-menus?accountId=acc-1');

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('GET /api/rich-menus error: Error');
      expect(logged).not.toContain('rich menu catalog secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('acc-1');
      expect(logged).not.toContain('richmenu-1');
      expect(logged).not.toContain('raw-body');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('friend rich menu link failure does not leak raw exception into logs or response', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });
    lineClientMethods.linkRichMenuToUser.mockRejectedValueOnce(
      new Error('friend rich menu secret account-token U-visible friend-visible menu-1 raw-body'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db, 'staff').request('/api/friends/friend-visible/rich-menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ richMenuId: 'menu-1' }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/friends/:friendId/rich-menu error: Error');
      expect(logged).not.toContain('friend rich menu secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('friend-visible');
      expect(logged).not.toContain('menu-1');
      expect(logged).not.toContain('raw-body');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('rich menu routes reject malformed catalog and friend inputs before DB or LINE side effects', async () => {
    const db = makeDb({ visibleFriendIds: ['friend-visible'] });
    const app = setupApp(db, 'owner');
    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/rich-menus?accountId=bad%20account'],
      ['POST', '/api/rich-menus', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(['bad']),
      }],
      ['POST', '/api/rich-menus', {
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }],
      ['POST', '/api/rich-menus', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'VIP', selected: 'yes' }),
      }],
      ['DELETE', '/api/rich-menus/bad%20menu'],
      ['POST', '/api/rich-menus/bad%20menu/default'],
      ['POST', '/api/rich-menus/menu-1/image', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: '%%%%' }),
      }],
      ['POST', '/api/rich-menus/menu-1/image?accountId=bad%20account', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: 'AAAA' }),
      }],
      ['GET', '/api/friends/bad%20friend/rich-menu'],
      ['DELETE', '/api/friends/bad%20friend/rich-menu'],
      ['POST', '/api/friends/bad%20friend/rich-menu', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ richMenuId: 'menu-1' }),
      }],
      ['POST', '/api/friends/friend-visible/rich-menu', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ richMenuId: 'bad menu' }),
      }],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(400);
    }

    expect(dbMocks.getFriendById).not.toHaveBeenCalled();
    expect(dbMocks.getLineAccountById).not.toHaveBeenCalled();
    expect(lineClientConstructor).not.toHaveBeenCalled();
  });
});
