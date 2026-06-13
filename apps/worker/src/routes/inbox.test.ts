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

function loggedText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join(' ');
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

  test('unanswered list ignores invalid numeric query values before calling the service', async () => {
    const db = {} as D1Database;

    const res = await setupApp(db).request('/api/inbox/unanswered?q=%20&page=abc&pageSize=-10&minWaitMinutes=1.5');

    expect(res.status).toBe(200);
    expect(inboxMocks.computeUnansweredInbox).toHaveBeenCalledWith(db, {
      q: undefined,
      account: undefined,
      minWaitMinutes: undefined,
      page: undefined,
      pageSize: undefined,
      staff: { id: 'staff-1', name: '田島', role: 'staff' },
    });
  });

  test('unanswered list rejects unsafe text and account filters before service calls', async () => {
    const db = {} as D1Database;
    const tooLongQuery = 'a'.repeat(257);
    const paths = [
      `/api/inbox/unanswered?q=${tooLongQuery}`,
      '/api/inbox/unanswered?account=bad%20account',
      `/api/inbox/unanswered?account=${'a'.repeat(129)}`,
    ];

    for (const path of paths) {
      const res = await setupApp(db).request(path);
      expect(res.status, path).toBe(400);
      expect(inboxMocks.computeUnansweredInbox, path).not.toHaveBeenCalled();
    }
  });

  test('unanswered list trims filters and caps oversized numeric values before service calls', async () => {
    const db = {} as D1Database;

    const res = await setupApp(db).request(
      '/api/inbox/unanswered?q=%20%E7%9B%B8%E8%AB%87%20&account=%20acc-1%20&page=999999&pageSize=999999&minWaitMinutes=999999',
    );

    expect(res.status).toBe(200);
    expect(inboxMocks.computeUnansweredInbox).toHaveBeenCalledWith(db, {
      q: '相談',
      account: 'acc-1',
      minWaitMinutes: 525_600,
      page: 10_000,
      pageSize: 2_000,
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

  test('unanswered count rejects unsafe filters before service calls', async () => {
    const db = {} as D1Database;
    const paths = [
      `/api/inbox/unanswered/count?q=${'a'.repeat(257)}`,
      '/api/inbox/unanswered/count?account=bad%20account',
    ];

    for (const path of paths) {
      const res = await setupApp(db).request(path);
      expect(res.status, path).toBe(400);
      expect(inboxMocks.countUnanswered, path).not.toHaveBeenCalled();
    }
  });

  test('unanswered count ignores invalid minWaitMinutes before calling the service', async () => {
    const db = {} as D1Database;

    const res = await setupApp(db).request('/api/inbox/unanswered/count?minWaitMinutes=NaN');

    expect(res.status).toBe(200);
    expect(inboxMocks.countUnanswered).toHaveBeenCalledWith(db, {
      q: undefined,
      account: undefined,
      minWaitMinutes: undefined,
      staff: {
        id: 'staff-1',
        name: '田島',
        role: 'staff',
      },
    });
  });

  test('unanswered count trims filters and caps oversized wait filter before service calls', async () => {
    const db = {} as D1Database;

    const res = await setupApp(db).request(
      '/api/inbox/unanswered/count?q=%20%E7%9B%B8%E8%AB%87%20&account=%20acc-1%20&minWaitMinutes=999999',
    );

    expect(res.status).toBe(200);
    expect(inboxMocks.countUnanswered).toHaveBeenCalledWith(db, {
      q: '相談',
      account: 'acc-1',
      minWaitMinutes: 525_600,
      staff: {
        id: 'staff-1',
        name: '田島',
        role: 'staff',
      },
    });
  });

  test('unanswered list failure logs only the error kind', async () => {
    const db = {} as D1Database;
    inboxMocks.computeUnansweredInbox.mockRejectedValueOnce(
      new Error('unanswered secret account-token U-visible friend-visible 相談'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db).request('/api/inbox/unanswered?q=%E7%9B%B8%E8%AB%87&account=acc-1');

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('GET /api/inbox/unanswered error: Error');
      expect(logged).not.toContain('unanswered secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('friend-visible');
      expect(logged).not.toContain('相談');
      expect(logged).not.toContain('acc-1');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('unanswered count failure logs only the error kind', async () => {
    const db = {} as D1Database;
    inboxMocks.countUnanswered.mockRejectedValueOnce(
      new Error('unanswered count secret account-token U-visible friend-visible 相談'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await setupApp(db).request('/api/inbox/unanswered/count?q=%E7%9B%B8%E8%AB%87&account=acc-1');

      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('GET /api/inbox/unanswered/count error: Error');
      expect(logged).not.toContain('unanswered count secret');
      expect(logged).not.toContain('account-token');
      expect(logged).not.toContain('U-visible');
      expect(logged).not.toContain('friend-visible');
      expect(logged).not.toContain('相談');
      expect(logged).not.toContain('acc-1');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
