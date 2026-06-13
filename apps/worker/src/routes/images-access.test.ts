import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const { images } = await import('./images.js');

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { IMAGES: R2Bucket; WORKER_URL: string };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

function createImagesBucket() {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as R2Bucket;
}

function setupApp(role: StaffRole = 'staff', bucket = createImagesBucket()) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Tajima', role });
    c.env = {
      IMAGES: bucket,
      WORKER_URL: 'https://worker.example.com',
    };
    await next();
  });
  app.route('/', images);
  return { app, bucket };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('image upload and delete role guard', () => {
  test('staff can still upload reply images', async () => {
    const { app, bucket } = setupApp('staff');

    const res = await app.request('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array([137, 80, 78, 71]),
    });

    expect(res.status).toBe(201);
    expect(bucket.put).toHaveBeenCalled();
  });

  test('rejects invalid JSON image payloads before R2 put', async () => {
    const requests = [
      '{',
      JSON.stringify({}),
      JSON.stringify({ data: '@@@@', mimeType: 'image/png' }),
      JSON.stringify({ data: 'aGVsbG8=', mimeType: 'text/plain' }),
      JSON.stringify({ data: 'data:image/png;base64', filename: 'reply.png' }),
      JSON.stringify({ data: 'aGVsbG8=', mimeType: 'image/png', filename: '../reply.png' }),
    ];

    for (const body of requests) {
      const { app, bucket } = setupApp('staff');
      const res = await app.request('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      expect(res.status, body).toBe(400);
      expect(bucket.put).not.toHaveBeenCalled();
    }
  });

  test('accepts JSON data URLs and trims safe filenames before R2 put', async () => {
    const { app, bucket } = setupApp('staff');

    const res = await app.request('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: 'data:image/png;base64,iVBORw0KGgo=',
        filename: ' reply.png ',
      }),
    });

    expect(res.status).toBe(201);
    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9-]+\.png$/),
      expect.any(ArrayBuffer),
      expect.objectContaining({
        httpMetadata: { contentType: 'image/png' },
        customMetadata: { originalFilename: 'reply.png' },
      }),
    );
  });

  test('public image reads reject unsafe keys before R2 get', async () => {
    const { app, bucket } = setupApp('staff');

    const res = await app.request('/images/bad%20key');

    expect(res.status).toBe(404);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  test('staff cannot delete arbitrary stored images', async () => {
    const { app, bucket } = setupApp('staff');

    const res = await app.request('/api/images/uploaded.png', { method: 'DELETE' });

    expect(res.status).toBe(403);
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  test('admin delete rejects unsafe keys before R2 delete', async () => {
    const { app, bucket } = setupApp('admin');

    const res = await app.request('/api/images/bad%20key', { method: 'DELETE' });

    expect(res.status).toBe(400);
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  test('admin can delete stored images', async () => {
    const { app, bucket } = setupApp('admin');

    const res = await app.request('/api/images/%20uploaded.png%20', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(bucket.delete).toHaveBeenCalledWith('uploaded.png');
  });
});
