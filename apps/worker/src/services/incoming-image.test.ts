import { describe, test, expect, vi } from 'vitest';
import { fetchAndStoreIncomingImage } from './incoming-image.js';

function makeR2Stub() {
  const store = new Map<string, { data: ArrayBuffer; contentType: string }>();
  return {
    put: vi.fn(async (key: string, data: ArrayBuffer, opts: { httpMetadata?: { contentType?: string } }) => {
      store.set(key, { data, contentType: opts.httpMetadata?.contentType ?? '' });
      return null;
    }),
    _store: store,
  };
}

function loggedText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().map(String).join(' ');
}

describe('fetchAndStoreIncomingImage', () => {
  test('Content API 成功時に R2 PUT して URL を返す', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(100), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    );

    const result = await fetchAndStoreIncomingImage({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'acc-1',
      messageId: 'msg-xyz',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-data.line.me/v2/bot/message/msg-xyz/content',
      expect.objectContaining({
        headers: { Authorization: 'Bearer token-abc' },
      }),
    );
    expect(r2.put).toHaveBeenCalled();
    const [key, , opts] = r2.put.mock.calls[0];
    expect(key).toBe('incoming-acc-1-msg-xyz.jpg');
    expect(opts.httpMetadata.contentType).toBe('image/jpeg');
    expect(result?.originalContentUrl).toBe('https://worker.example.com/images/incoming-acc-1-msg-xyz.jpg');
    expect(result?.previewImageUrl).toBe(result?.originalContentUrl);
  });

  test('Content API が非 200 を返したら null で識別子をログに出さない', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await fetchAndStoreIncomingImage({
        r2: r2 as unknown as R2Bucket,
        fetch: fetchMock,
        workerUrl: 'https://worker.example.com',
        channelAccessToken: 'token-bad',
        accountId: 'acc-1',
        messageId: 'msg-y',
      });

      expect(result).toBeNull();
      expect(r2.put).not.toHaveBeenCalled();
      const logged = loggedText(errorSpy);
      expect(logged).toContain('incoming-image: non-200: status=401');
      expect(logged).not.toContain('token-bad');
      expect(logged).not.toContain('acc-1');
      expect(logged).not.toContain('msg-y');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('fetch が throw したら null で raw 例外や識別子をログに出さない', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () => {
      throw new Error('upstream secret body token-abc acc-1 msg-fetch');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await fetchAndStoreIncomingImage({
        r2: r2 as unknown as R2Bucket,
        fetch: fetchMock,
        workerUrl: 'https://worker.example.com',
        channelAccessToken: 'token-abc',
        accountId: 'acc-1',
        messageId: 'msg-fetch',
      });

      expect(result).toBeNull();
      expect(r2.put).not.toHaveBeenCalled();
      const logged = loggedText(errorSpy);
      expect(logged).toContain('incoming-image: fetch failed: Error');
      expect(logged).not.toContain('upstream secret body');
      expect(logged).not.toContain('token-abc');
      expect(logged).not.toContain('acc-1');
      expect(logged).not.toContain('msg-fetch');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('R2 PUT が throw したら null で raw 例外や識別子をログに出さない', async () => {
    const r2 = makeR2Stub();
    r2.put.mockRejectedValueOnce(new Error('R2 down token-abc acc-1 msg-z'));
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(50), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await fetchAndStoreIncomingImage({
        r2: r2 as unknown as R2Bucket,
        fetch: fetchMock,
        workerUrl: 'https://worker.example.com',
        channelAccessToken: 'token-abc',
        accountId: 'acc-1',
        messageId: 'msg-z',
      });

      expect(result).toBeNull();
      const logged = loggedText(errorSpy);
      expect(logged).toContain('incoming-image: R2 put failed: Error');
      expect(logged).not.toContain('R2 down');
      expect(logged).not.toContain('token-abc');
      expect(logged).not.toContain('acc-1');
      expect(logged).not.toContain('msg-z');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('Content-Type から拡張子を判定 (png)', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(50), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );

    await fetchAndStoreIncomingImage({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'a',
      messageId: 'm-png',
    });

    const [key] = r2.put.mock.calls[0];
    expect(key).toBe('incoming-a-m-png.png');
  });
});
