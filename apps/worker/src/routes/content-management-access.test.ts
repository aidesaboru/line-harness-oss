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
  dbMocks.createTag.mockResolvedValue({
    id: 'tag-created',
    name: 'VIP',
    color: '#2563eb',
    created_at: '2026-06-13T10:00:00.000',
  });
  dbMocks.createTemplate.mockResolvedValue({
    id: 'template-created',
    name: 'Greeting',
    category: 'general',
    message_type: 'image',
    message_content: JSON.stringify({
      originalContentUrl: 'https://example.com/image.jpg',
      previewImageUrl: 'https://example.com/preview.jpg',
    }),
    created_at: '2026-06-13T10:00:00.000',
    updated_at: '2026-06-13T10:00:00.000',
  });
  dbMocks.getTemplateById.mockResolvedValue({
    id: 'template-1',
    name: 'Greeting',
    category: 'general',
    message_type: 'text',
    message_content: 'hello',
    created_at: '2026-06-13T10:00:00.000',
    updated_at: '2026-06-13T10:00:00.000',
  });
  dbMocks.updateTemplate.mockResolvedValue(undefined);
  dbMocks.createMessageTemplate.mockResolvedValue({
    id: 'message-template-created',
    name: 'Reward',
    message_type: 'text',
    message_content: 'hello',
    created_at: '2026-06-13T10:00:00.000',
    updated_at: '2026-06-13T10:00:00.000',
  });
  dbMocks.getMessageTemplateById.mockResolvedValue({
    id: 'message-template-1',
    name: 'Reward',
    message_type: 'text',
    message_content: 'hello',
    created_at: '2026-06-13T10:00:00.000',
    updated_at: '2026-06-13T10:00:00.000',
  });
  dbMocks.updateMessageTemplate.mockResolvedValue({
    id: 'message-template-1',
    name: 'Reward Updated',
    message_type: 'flex',
    message_content: JSON.stringify({ type: 'bubble' }),
    created_at: '2026-06-13T10:00:00.000',
    updated_at: '2026-06-13T10:05:00.000',
  });
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

  test('staff cannot read or mutate reusable templates', async () => {
    const app = setupApp('staff');
    const requests: Array<[string, string, RequestInit?]> = [
      ['GET', '/api/templates'],
      ['GET', '/api/templates/template-1'],
      ['GET', '/api/templates/template-1/usages'],
      ['POST', '/api/templates', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Greeting', messageType: 'text', messageContent: 'hello' }),
      }],
      ['PUT', '/api/templates/template-1', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageContent: 'updated' }),
      }],
      ['DELETE', '/api/templates/template-1'],
      ['GET', '/api/message-templates'],
      ['GET', '/api/message-templates/message-template-1'],
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

    expect(dbMocks.getTemplatesWithUsageCount).not.toHaveBeenCalled();
    expect(dbMocks.getTemplateById).not.toHaveBeenCalled();
    expect(dbMocks.getTemplateUsage).not.toHaveBeenCalled();
    expect(dbMocks.createTemplate).not.toHaveBeenCalled();
    expect(dbMocks.updateTemplate).not.toHaveBeenCalled();
    expect(dbMocks.deleteTemplate).not.toHaveBeenCalled();
    expect(dbMocks.listMessageTemplates).not.toHaveBeenCalled();
    expect(dbMocks.getMessageTemplateById).not.toHaveBeenCalled();
    expect(dbMocks.createMessageTemplate).not.toHaveBeenCalled();
    expect(dbMocks.updateMessageTemplate).not.toHaveBeenCalled();
    expect(dbMocks.deleteMessageTemplate).not.toHaveBeenCalled();
  });
});

describe('content management payload validation', () => {
  test('reusable template list rejects oversized category query before DB helper calls', async () => {
    const app = setupApp('owner');
    const oversizedCategory = 'x'.repeat(65);

    const res = await app.request(`/api/templates?category=${oversizedCategory}`);

    expect(res.status).toBe(400);
    expect(dbMocks.getTemplatesWithUsageCount).not.toHaveBeenCalled();
  });

  test('reusable template list trims valid category query before DB helper calls', async () => {
    dbMocks.getTemplatesWithUsageCount.mockResolvedValue([
      {
        id: 'template-1',
        name: 'Greeting',
        category: 'general',
        message_type: 'text',
        message_content: 'hello',
        usage_count: 0,
        created_at: '2026-06-13T10:00:00.000',
        updated_at: '2026-06-13T10:00:00.000',
      },
    ]);
    const app = setupApp('owner');

    const res = await app.request('/api/templates?category=%20general%20');

    expect(res.status).toBe(200);
    expect(dbMocks.getTemplatesWithUsageCount).toHaveBeenCalledWith({} as D1Database, 'general');
  });

  test('tag create rejects malformed or invalid payloads before DB writes', async () => {
    const app = setupApp('owner');

    const malformed = await app.request('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    const missingName = await app.request('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ' ', color: '#2563eb' }),
    });
    const invalidColor = await app.request('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'VIP', color: 'green' }),
    });

    expect(malformed.status).toBe(400);
    expect(missingName.status).toBe(400);
    expect(invalidColor.status).toBe(400);
    expect(dbMocks.createTag).not.toHaveBeenCalled();
  });

  test('tag create trims valid payloads before DB writes', async () => {
    const app = setupApp('owner');

    const res = await app.request('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ' VIP ', color: ' #2563eb ' }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createTag).toHaveBeenCalledWith({} as D1Database, {
      name: 'VIP',
      color: '#2563eb',
    });
  });

  test('tag delete rejects malformed path IDs before DB writes', async () => {
    const app = setupApp('owner');

    const res = await app.request('/api/tags/bad%20id', { method: 'DELETE' });

    expect(res.status).toBe(400);
    expect(dbMocks.deleteTag).not.toHaveBeenCalled();
  });

  test('tag delete trims valid path IDs before DB writes', async () => {
    const app = setupApp('owner');

    const res = await app.request('/api/tags/%20tag-1%20', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(dbMocks.deleteTag).toHaveBeenCalledWith({} as D1Database, 'tag-1');
  });

  test('reusable template create rejects malformed or invalid payloads before DB writes', async () => {
    const app = setupApp('owner');

    const malformed = await app.request('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    const invalidType = await app.request('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Greeting', messageType: 'video', messageContent: 'hello' }),
    });
    const invalidFlex = await app.request('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Greeting', messageType: 'flex', messageContent: '{' }),
    });

    expect(malformed.status).toBe(400);
    expect(invalidType.status).toBe(400);
    expect(invalidFlex.status).toBe(400);
    expect(dbMocks.createTemplate).not.toHaveBeenCalled();
  });

  test('reusable template create trims valid payloads before DB writes', async () => {
    const app = setupApp('owner');
    const imageContent = JSON.stringify({
      originalContentUrl: 'https://example.com/image.jpg',
      previewImageUrl: 'https://example.com/preview.jpg',
    });

    const res = await app.request('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ' Greeting ',
        category: ' general ',
        messageType: ' image ',
        messageContent: ` ${imageContent} `,
      }),
    });

    expect(res.status).toBe(201);
    expect(dbMocks.createTemplate).toHaveBeenCalledWith({} as D1Database, {
      name: 'Greeting',
      category: 'general',
      messageType: 'image',
      messageContent: imageContent,
    });
  });

  test('reusable template update rejects malformed or empty payloads before lookup', async () => {
    const app = setupApp('owner');

    const malformed = await app.request('/api/templates/template-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    const empty = await app.request('/api/templates/template-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const invalidType = await app.request('/api/templates/template-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageType: 'video' }),
    });

    expect(malformed.status).toBe(400);
    expect(empty.status).toBe(400);
    expect(invalidType.status).toBe(400);
    expect(dbMocks.getTemplateById).not.toHaveBeenCalled();
    expect(dbMocks.updateTemplate).not.toHaveBeenCalled();
  });

  test('reusable template update rejects invalid effective content before DB writes', async () => {
    const app = setupApp('owner');
    dbMocks.getTemplateById.mockResolvedValueOnce({
      id: 'template-1',
      name: 'Greeting',
      category: 'general',
      message_type: 'flex',
      message_content: JSON.stringify({ type: 'bubble' }),
      created_at: '2026-06-13T10:00:00.000',
      updated_at: '2026-06-13T10:00:00.000',
    });

    const res = await app.request('/api/templates/template-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageContent: '{' }),
    });

    expect(res.status).toBe(400);
    expect(dbMocks.getTemplateById).toHaveBeenCalledTimes(1);
    expect(dbMocks.updateTemplate).not.toHaveBeenCalled();
  });

  test('message template create rejects malformed or invalid payloads before DB writes', async () => {
    const app = setupApp('owner');

    const malformed = await app.request('/api/message-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    const invalidType = await app.request('/api/message-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reward', messageType: 'image', messageContent: 'hello' }),
    });
    const invalidFlex = await app.request('/api/message-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Reward', messageType: 'flex', messageContent: 'not json' }),
    });

    expect(malformed.status).toBe(400);
    expect(invalidType.status).toBe(400);
    expect(invalidFlex.status).toBe(400);
    expect(dbMocks.createMessageTemplate).not.toHaveBeenCalled();
  });

  test('message template update rejects malformed or invalid payloads before lookup', async () => {
    const app = setupApp('owner');

    const malformed = await app.request('/api/message-templates/message-template-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    const empty = await app.request('/api/message-templates/message-template-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const invalidType = await app.request('/api/message-templates/message-template-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageType: 'image' }),
    });

    expect(malformed.status).toBe(400);
    expect(empty.status).toBe(400);
    expect(invalidType.status).toBe(400);
    expect(dbMocks.getMessageTemplateById).not.toHaveBeenCalled();
    expect(dbMocks.updateMessageTemplate).not.toHaveBeenCalled();
  });

  test('message template update trims valid payloads before DB writes', async () => {
    const app = setupApp('owner');
    const flexContent = JSON.stringify({ type: 'bubble' });

    const res = await app.request('/api/message-templates/message-template-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ' Reward Updated ',
        messageType: ' flex ',
        messageContent: ` ${flexContent} `,
      }),
    });

    expect(res.status).toBe(200);
    expect(dbMocks.getMessageTemplateById).toHaveBeenCalledWith({} as D1Database, 'message-template-1');
    expect(dbMocks.updateMessageTemplate).toHaveBeenCalledWith({} as D1Database, 'message-template-1', {
      name: 'Reward Updated',
      messageType: 'flex',
      messageContent: flexContent,
    });
  });
});
