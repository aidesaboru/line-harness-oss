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

  test('staff cannot delete arbitrary stored images', async () => {
    const { app, bucket } = setupApp('staff');

    const res = await app.request('/api/images/uploaded.png', { method: 'DELETE' });

    expect(res.status).toBe(403);
    expect(bucket.delete).not.toHaveBeenCalled();
  });

  test('admin can delete stored images', async () => {
    const { app, bucket } = setupApp('admin');

    const res = await app.request('/api/images/uploaded.png', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(bucket.delete).toHaveBeenCalledWith('uploaded.png');
  });
});
