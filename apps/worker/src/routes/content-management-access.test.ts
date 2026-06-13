import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getTags: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  getTemplatesWithUsageCount: vi.fn(),
  getTemplateById: vi.fn(),
  getTemplateUsage: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  listMessageTemplates: vi.fn(),
  getMessageTemplateById: vi.fn(),
  createMessageTemplate: vi.fn(),
  updateMessageTemplate: vi.fn(),
  deleteMessageTemplate: vi.fn(),
};

vi.mock('@line-crm/db', () => dbMocks);

const { tags } = await import('./tags.js');
const { templates } = await import('./templates.js');
const { messageTemplates } = await import('./message-templates.js');

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
  app.route('/', tags);
  app.route('/', templates);
  app.route('/', messageTemplates);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('content management role guards', () => {
  test('staff cannot create or delete tag definitions', async () => {
    const app = setupApp('staff');

    const create = await app.request('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'VIP', color: '#2563eb' }),
    });
    const del = await app.request('/api/tags/tag-1', { method: 'DELETE' });

    expect(create.status).toBe(403);
    expect(del.status).toBe(403);
    expect(dbMocks.createTag).not.toHaveBeenCalled();
    expect(dbMocks.deleteTag).not.toHaveBeenCalled();
  });

  test('staff cannot mutate reusable templates', async () => {
    const app = setupApp('staff');
    const requests: Array<[string, string, RequestInit?]> = [
      ['POST', '/api/templates', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Greeting', messageType: 'text', messageContent: 'hello' }),
      }],
      ['PUT', '/api/templates/template-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageContent: 'updated' }),
      }],
      ['DELETE', '/api/templates/template-1'],
      ['POST', '/api/message-templates', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Intro', messageType: 'text', messageContent: 'hello' }),
      }],
      ['PUT', '/api/message-templates/message-template-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageContent: 'updated' }),
      }],
      ['DELETE', '/api/message-templates/message-template-1'],
    ];

    for (const [method, path, init] of requests) {
      const res = await app.request(path, { ...init, method });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect(dbMocks.createTemplate).not.toHaveBeenCalled();
    expect(dbMocks.updateTemplate).not.toHaveBeenCalled();
    expect(dbMocks.deleteTemplate).not.toHaveBeenCalled();
    expect(dbMocks.createMessageTemplate).not.toHaveBeenCalled();
    expect(dbMocks.updateMessageTemplate).not.toHaveBeenCalled();
    expect(dbMocks.deleteMessageTemplate).not.toHaveBeenCalled();
  });
});
