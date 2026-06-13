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
  getTrackedLinkById: vi.fn(),
  getMessageTemplateById: vi.fn(),
  addTagToFriend: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  jstNow: vi.fn(() => '2026-06-13T10:00:00.000+09:00'),
};

const liffAuthMocks = {
  verifyCallerLineUserId: vi.fn(),
};

vi.mock('@line-crm/db', () => dbMocks);
vi.mock('../services/liff-auth.js', () => liffAuthMocks);

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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  liffAuthMocks.verifyCallerLineUserId.mockResolvedValue(null);
  dbMocks.createFormSubmission.mockImplementation(async (_db, input: {
    formId: string;
    friendId: string | null;
    data: string;
  }) => ({
    id: 'submission-1',
    form_id: input.formId,
    friend_id: input.friendId,
    data: input.data,
    created_at: '2026-06-13T10:01:00.000',
  }));
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

  test('public form partial submit requires verified LINE idToken before metadata write', async () => {
    const res = await setupApp('staff').request('/api/forms/form-1/partial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        friendId: 'friend-victim',
        lineUserId: 'U-victim',
        data: { answer: 'draft' },
      }),
    });

    expect(res.status).toBe(401);
    expect(liffAuthMocks.verifyCallerLineUserId).toHaveBeenCalledWith(undefined, expect.anything());
    expect(dbMocks.getFriendById).not.toHaveBeenCalledWith({} as D1Database, 'friend-victim');
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalledWith({} as D1Database, 'U-victim');
  });

  test('public form partial submit rejects invalid data before LINE idToken verification', async () => {
    const app = setupApp('staff');
    const invalidJson = await app.request('/api/forms/form-1/partial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    const arrayData = await app.request('/api/forms/form-1/partial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'id-token', data: ['not', 'an', 'object'] }),
    });

    expect(invalidJson.status).toBe(400);
    expect(arrayData.status).toBe(400);
    expect(liffAuthMocks.verifyCallerLineUserId).not.toHaveBeenCalled();
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalled();
  });

  test('public form submit rejects oversized data before webhook or submission writes', async () => {
    dbMocks.getFormById.mockResolvedValue({
      id: 'form-1',
      name: 'Survey',
      description: null,
      fields: '[]',
      on_submit_tag_id: 'tag-reward',
      on_submit_scenario_id: 'scenario-reward',
      on_submit_message_type: null,
      on_submit_message_content: null,
      on_submit_webhook_url: 'https://x-harness.test/api/engagement-gates/gate-1/verify',
      on_submit_webhook_headers: null,
      on_submit_webhook_fail_message: null,
      save_to_metadata: 0,
      is_active: 1,
      submit_count: 0,
      created_at: '2026-06-13T10:00:00.000',
      updated_at: '2026-06-13T10:00:00.000',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await setupApp('staff').request('/api/forms/form-1/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { answer: 'x'.repeat(17_000) } }),
    });

    expect(res.status).toBe(400);
    expect(liffAuthMocks.verifyCallerLineUserId).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMocks.createFormSubmission).not.toHaveBeenCalled();
    expect(dbMocks.addTagToFriend).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();
  });

  test('public form submit ignores _skipWebhook and rechecks webhook gate server-side', async () => {
    dbMocks.getFormById.mockResolvedValue({
      id: 'form-1',
      name: 'Survey',
      description: null,
      fields: JSON.stringify([{ name: 'x_username', label: 'X ID', type: 'text', required: true }]),
      on_submit_tag_id: 'tag-reward',
      on_submit_scenario_id: 'scenario-reward',
      on_submit_message_type: null,
      on_submit_message_content: null,
      on_submit_webhook_url: 'https://x-harness.test/api/engagement-gates/gate-1/verify?username={x_username}',
      on_submit_webhook_headers: null,
      on_submit_webhook_fail_message: null,
      save_to_metadata: 0,
      is_active: 1,
      submit_count: 0,
      created_at: '2026-06-13T10:00:00.000',
      updated_at: '2026-06-13T10:00:00.000',
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { eligible: false } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await setupApp('staff').request('/api/forms/form-1/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        _skipWebhook: true,
        data: { x_username: 'alice', _skipWebhook: true },
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as { data: { webhookPassed?: boolean; webhookData?: unknown } };
    expect(json.data.webhookPassed).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://x-harness.test/api/engagement-gates/gate-1/verify?username=alice',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(dbMocks.addTagToFriend).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();

    const [, input] = dbMocks.createFormSubmission.mock.calls[0] as [
      D1Database,
      { data: string },
    ];
    const saved = JSON.parse(input.data) as Record<string, unknown>;
    expect(saved).not.toHaveProperty('_skipWebhook');
    expect(saved).toMatchObject({
      x_username: 'alice',
      _webhookResult: { success: true, data: { eligible: false } },
    });
  });

  test('public form submit does not trust caller-supplied friend identifiers for side effects', async () => {
    dbMocks.getFormById.mockResolvedValue({
      id: 'form-1',
      name: 'Survey',
      description: null,
      fields: '[]',
      on_submit_tag_id: 'tag-reward',
      on_submit_scenario_id: 'scenario-reward',
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

    const res = await setupApp('staff').request('/api/forms/form-1/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        friendId: 'friend-victim',
        lineUserId: 'U-victim',
        data: { answer: 'hello' },
      }),
    });

    expect(res.status).toBe(201);
    expect(liffAuthMocks.verifyCallerLineUserId).toHaveBeenCalledWith(undefined, expect.anything());
    expect(dbMocks.getFriendById).not.toHaveBeenCalledWith({} as D1Database, 'friend-victim');
    expect(dbMocks.getFriendByLineUserId).not.toHaveBeenCalledWith({} as D1Database, 'U-victim');
    expect(dbMocks.addTagToFriend).not.toHaveBeenCalled();
    expect(dbMocks.enrollFriendInScenario).not.toHaveBeenCalled();

    const [, input] = dbMocks.createFormSubmission.mock.calls[0] as [
      D1Database,
      { friendId: string | null; data: string },
    ];
    expect(input.friendId).toBeNull();
    expect(JSON.parse(input.data)).toEqual({ answer: 'hello' });
  });

  test('public form submit uses verified LINE idToken for friend-linked side effects', async () => {
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U-verified');
    dbMocks.getFriendByLineUserId.mockResolvedValue({
      id: 'friend-verified',
      display_name: 'Verified User',
      metadata: '{}',
      line_user_id: 'U-verified',
    });
    dbMocks.getFormById.mockResolvedValue({
      id: 'form-1',
      name: 'Survey',
      description: null,
      fields: '[]',
      on_submit_tag_id: 'tag-reward',
      on_submit_scenario_id: 'scenario-reward',
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

    const res = await setupApp('staff').request('/api/forms/form-1/submit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer id-token',
      },
      body: JSON.stringify({ data: { answer: 'hello' } }),
    });

    expect(res.status).toBe(201);
    expect(liffAuthMocks.verifyCallerLineUserId).toHaveBeenCalledWith('Bearer id-token', expect.anything());
    expect(dbMocks.getFriendByLineUserId).toHaveBeenCalledWith({} as D1Database, 'U-verified');
    expect(dbMocks.addTagToFriend).toHaveBeenCalledWith({} as D1Database, 'friend-verified', 'tag-reward');
    expect(dbMocks.enrollFriendInScenario).toHaveBeenCalledWith({} as D1Database, 'friend-verified', 'scenario-reward');

    const [, input] = dbMocks.createFormSubmission.mock.calls[0] as [
      D1Database,
      { friendId: string | null; data: string },
    ];
    expect(input.friendId).toBe('friend-verified');
    expect(JSON.parse(input.data)).toEqual({ answer: 'hello' });
  });

  test('public form submit stores a redacted webhook error when webhook fetch fails', async () => {
    dbMocks.getFormById.mockResolvedValue({
      id: 'form-1',
      name: 'Survey',
      description: null,
      fields: JSON.stringify([{ name: 'x_username', label: 'X ID', type: 'text', required: true }]),
      on_submit_tag_id: null,
      on_submit_scenario_id: null,
      on_submit_message_type: null,
      on_submit_message_content: null,
      on_submit_webhook_url: 'https://x-harness.test/api/engagement-gates/gate-1/verify?username={x_username}',
      on_submit_webhook_headers: null,
      on_submit_webhook_fail_message: null,
      save_to_metadata: 0,
      is_active: 1,
      submit_count: 0,
      created_at: '2026-06-13T10:00:00.000',
      updated_at: '2026-06-13T10:00:00.000',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret response body')));

    const res = await setupApp('staff').request('/api/forms/form-1/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { x_username: 'alice' } }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as { data: { webhookPassed?: boolean; webhookData?: { error?: string } } };
    expect(json.data.webhookPassed).toBe(false);
    expect(json.data.webhookData?.error).toBe('webhook_error');

    const [, input] = dbMocks.createFormSubmission.mock.calls[0] as [
      D1Database,
      { data: string },
    ];
    const saved = JSON.parse(input.data) as { _webhookResult?: { error?: string } };
    expect(saved._webhookResult?.error).toBe('webhook_error');
  });
});
