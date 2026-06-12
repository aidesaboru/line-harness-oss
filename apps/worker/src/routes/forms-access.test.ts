import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getForms: vi.fn(),
  getFormsWithStats: vi.fn(),
  getFormById: vi.fn(),
  createForm: vi.fn(),
  updateForm: vi.fn(),
  deleteForm: vi.fn(),
  getFormSubmissions: vi.fn(),
  createFormSubmission: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getFriendById: vi.fn(),
  addTagToFriend: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  jstNow: vi.fn(() => '2026-06-13T10:00:00.000+09:00'),
};

vi.mock('@line-crm/db', () => dbMocks);

const { forms } = await import('./forms.js');

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { DB: D1Database; LINE_CHANNEL_ACCESS_TOKEN: string };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

function setupApp(role: StaffRole = 'staff') {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Tajima', role });
    c.env = {
      DB: {} as D1Database,
      LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
    };
    await next();
  });
  app.route('/', forms);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getFormById.mockResolvedValue({
    id: 'form-1',
    name: 'Survey',
    description: null,
    fields: '[]',
    on_submit_tag_id: null,
    on_submit_scenario_id: null,
    on_submit_message_type: null,
    on_submit_message_content: null,
    on_submit_webhook_url: null,
    on_submit_webhook_headers: null,
    on_submit_webhook_fail_message: null,
    save_to_metadata: 0,
    is_active: 1,
    submit_count: 0,
    created_at: '2026-06-13T10:00:00.000',
    updated_at: '2026-06-13T10:00:00.000',
  });
});

describe('form management role guards', () => {
  test('staff cannot access form management or submission APIs', async () => {
    const app = setupApp('staff');

    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/forms'],
      ['POST', '/api/forms', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Survey', fields: [] }),
      }],
      ['PUT', '/api/forms/form-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      }],
      ['DELETE', '/api/forms/form-1'],
      ['GET', '/api/forms/form-1/submissions'],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(dbMocks.getFormsWithStats).not.toHaveBeenCalled();
    expect(dbMocks.createForm).not.toHaveBeenCalled();
    expect(dbMocks.updateForm).not.toHaveBeenCalled();
    expect(dbMocks.deleteForm).not.toHaveBeenCalled();
    expect(dbMocks.getFormSubmissions).not.toHaveBeenCalled();
  });

  test('public form definition route remains unguarded', async () => {
    const res = await setupApp('staff').request('/api/forms/form-1');

    expect(res.status).toBe(200);
    expect(dbMocks.getFormById).toHaveBeenCalledWith({} as D1Database, 'form-1');
  });
});
