import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const { images } = await import('./images.js');

type StaffRole = 'owner' | 'admin' | 'staff';

type TestEnv = {
  Bindings: { IMAGES?: R2Bucket; FILES?: KVNamespace; WORKER_URL: string };
  Variables: { staff: { id: string; name: string; role: StaffRole } };
};

function createImagesBucket() {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as R2Bucket;
}

function createFilesKv() {
  const stored = new Map<string, { value: ArrayBuffer; metadata: unknown }>();
  return {
    put: vi.fn(async (key: string, value: ArrayBuffer | string, options?: { metadata?: unknown }) => {
      const body = typeof value === 'string' ? new TextEncoder().encode(value).buffer : value;
      stored.set(key, { value: body, metadata: options?.metadata ?? null });
    }),
    getWithMetadata: vi.fn(async (key: string) => {
      const item = stored.get(key);
      return {
        value: item?.value ?? null,
        metadata: item?.metadata ?? null,
      };
    }),
    delete: vi.fn(async (key: string) => {
      stored.delete(key);
    }),
  } as unknown as KVNamespace;
}

function setupApp(role: StaffRole = 'staff', bucket: R2Bucket | null = createImagesBucket(), files?: KVNamespace) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: 'Tajima', role });
    c.env = {
      ...(bucket ? { IMAGES: bucket } : {}),
      ...(files ? { FILES: files } : {}),
      WORKER_URL: 'https://worker.example.com',
    };
    await next();
  });
  app.route('/', images);
  return { app, bucket };
}

function loggedText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join(' ');
}

function expectNoLogLeak(logged: string, values: string[]): void {
  for (const value of values) {
    expect(logged).not.toContain(value);
  }
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

  test('staff can upload PDF files for chat links', async () => {
    const { app, bucket } = setupApp('staff');

    const res = await app.request('/api/files', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-File-Name': encodeURIComponent('見積書.pdf'),
      },
      body: new TextEncoder().encode('%PDF-1.4'),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { url: string; mimeType: string; filename: string };
    };
    expect(body.data.url).toMatch(/^https:\/\/worker\.example\.com\/files\/[a-f0-9-]+\.pdf$/);
    expect(body.data.mimeType).toBe('application/pdf');
    expect(body.data.filename).toBe('見積書.pdf');
    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9-]+\.pdf$/),
      expect.any(ArrayBuffer),
      expect.objectContaining({
        httpMetadata: { contentType: 'application/pdf' },
        customMetadata: { originalFilename: '見積書.pdf' },
      }),
    );
  });

  test('accepts PDFs over the former 10MB limit with KV fallback', async () => {
    const files = createFilesKv();
    const { app } = setupApp('staff', null, files);
    const data = new Uint8Array(11 * 1024 * 1024);
    data.set(new TextEncoder().encode('%PDF-1.7'));

    const res = await app.request('/api/files', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-File-Name': encodeURIComponent('大きめ資料.pdf'),
      },
      body: data,
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { size: number; filename: string } };
    expect(body.data.size).toBe(data.byteLength);
    expect(body.data.filename).toBe('大きめ資料.pdf');
    expect(files.put).toHaveBeenCalled();
  });

  test('accepts PDF extension when browser sends octet-stream', async () => {
    const files = createFilesKv();
    const { app } = setupApp('staff', null, files);

    const res = await app.request('/api/files', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent('ブラウザ判定なし.pdf'),
      },
      body: new TextEncoder().encode('%PDF-1.7'),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { mimeType: string; filename: string } };
    expect(body.data.mimeType).toBe('application/pdf');
    expect(body.data.filename).toBe('ブラウザ判定なし.pdf');
  });

  test('rejects PDFs over the KV storage limit with a clear message', async () => {
    const files = createFilesKv();
    const { app } = setupApp('staff', null, files);

    const res = await app.request('/api/files', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-File-Name': encodeURIComponent('大きすぎる資料.pdf'),
      },
      body: new Uint8Array(25 * 1024 * 1024 + 1),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'PDFは25MB以下にしてください。' });
    expect(files.put).not.toHaveBeenCalled();
  });

  test('falls back to KV for PDF upload when R2 is not bound', async () => {
    const files = createFilesKv();
    const { app } = setupApp('staff', null, files);

    const uploadRes = await app.request('/api/files', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-File-Name': encodeURIComponent('請求書.pdf'),
      },
      body: new TextEncoder().encode('%PDF-1.7'),
    });

    expect(uploadRes.status).toBe(201);
    const body = (await uploadRes.json()) as {
      data: { key: string; url: string; mimeType: string; filename: string };
    };
    expect(body.data.mimeType).toBe('application/pdf');
    expect(body.data.filename).toBe('請求書.pdf');
    expect(files.put).toHaveBeenCalledWith(
      body.data.key,
      expect.any(ArrayBuffer),
      expect.objectContaining({
        metadata: { contentType: 'application/pdf', originalFilename: '請求書.pdf' },
      }),
    );

    const readPath = new URL(body.data.url).pathname;
    const readRes = await app.request(readPath);
    expect(readRes.status).toBe(200);
    expect(readRes.headers.get('Content-Type')).toBe('application/pdf');
    expect(readRes.headers.get('Content-Disposition')).toContain(encodeURIComponent('請求書.pdf'));
    expect(await readRes.text()).toBe('%PDF-1.7');
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

  test('image upload and delete failures log only the error kind', async () => {
    const uploadBucket = createImagesBucket();
    vi.mocked(uploadBucket.put).mockRejectedValueOnce(
      new Error('image upload secret reply.png uploaded.png token-secret raw-body'),
    );
    const deleteBucket = createImagesBucket();
    vi.mocked(deleteBucket.delete).mockRejectedValueOnce(
      new Error('image delete secret reply.png uploaded.png token-secret raw-body'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const uploadRes = await setupApp('staff', uploadBucket).app.request('/api/images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: 'iVBORw0KGgo=',
          mimeType: 'image/png',
          filename: 'reply.png',
        }),
      });
      const deleteRes = await setupApp('admin', deleteBucket).app.request('/api/images/uploaded.png', {
        method: 'DELETE',
      });

      expect(uploadRes.status).toBe(500);
      expect(await uploadRes.json()).toEqual({ success: false, error: 'Internal server error' });
      expect(deleteRes.status).toBe(500);
      expect(await deleteRes.json()).toEqual({ success: false, error: 'Internal server error' });
      const logged = loggedText(errorSpy);
      expect(logged).toContain('POST /api/images error: Error');
      expect(logged).toContain('DELETE /api/images/:key error: Error');
      expectNoLogLeak(logged, [
        'image upload secret',
        'image delete secret',
        'reply.png',
        'uploaded.png',
        'token-secret',
        'raw-body',
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
