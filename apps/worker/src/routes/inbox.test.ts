import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const inboxMocks = {
  computeUnansweredInbox: vi.fn(),
  countUnanswered: vi.fn(),
};

vi.mock('../services/unanswered-inbox.js', () => inboxMocks);

const { inbox } = await import('./inbox.js');

type TestEnv = {
  Bindings: { DB: D1Database };
  Variables: { staff: { id: string; name: string; role: 'owner' | 'admin' | 'staff' } };
};

function setupApp(db: D1Database) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '田島', role: 'staff' });
    c.env = { DB: db };
    await next();
  });
  app.route('/', inbox);
  return app;
}

describe('inbox routes support visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inboxMocks.computeUnansweredInbox.mockResolvedValue({ total: 0, page: 1, pageSize: 50, rows: [] });
    inboxMocks.countUnanswered.mockResolvedValue({ total: 0, byAccount: [], oldestWaitMinutes: null });
  });

  test('unanswered list passes current staff into the service scope', async () => {
    const db = {} as D1Database;

    const res = await setupApp(db).request('/api/inbox/unanswered?q=%E7%9B%B8%E8%AB%87&page=2&pageSize=10');

    expect(res.status).toBe(200);
    expect(inboxMocks.computeUnansweredInbox).toHaveBeenCalledWith(db, {
      q: '相談',
      account: undefined,
      minWaitMinutes: undefined,
      page: 2,
      pageSize: 10,
      staff: { id: 'staff-1', name: '田島', role: 'staff' },
    });
  });

  test('unanswered count passes filters and current staff into the service scope', async () => {
    const db = {} as D1Database;

    const res = await setupApp(db).request('/api/inbox/unanswered/count?q=%E7%9B%B8%E8%AB%87&account=acc-1&minWaitMinutes=60');

    expect(res.status).toBe(200);
    expect(inboxMocks.countUnanswered).toHaveBeenCalledWith(db, {
      q: '相談',
      account: 'acc-1',
      minWaitMinutes: 60,
      staff: {
        id: 'staff-1',
        name: '田島',
        role: 'staff',
      },
    });
  });
});
