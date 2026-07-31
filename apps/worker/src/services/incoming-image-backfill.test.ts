import { describe, expect, test, vi } from 'vitest';
import { backfillIncomingImages } from './incoming-image-backfill.js';

type Candidate = {
  scope: 'personal' | 'group';
  id: string;
  content: string;
  line_message_id: string;
  line_account_id: string | null;
  created_at: string;
  cursor_key: string;
};

function makeDb(candidates: Candidate[]) {
  const updates: Array<{ sql: string; values: unknown[] }> = [];
  const preparedSql: string[] = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      preparedSql.push(sql);
      const queryAll = async (values: unknown[] = []) => {
        if (sql.includes('WITH candidates AS')) {
          const cursor = values[0] as string | null;
          const limit = Number(values[2]);
          return {
            results: candidates
              .filter((candidate) => !cursor || candidate.cursor_key < cursor)
              .sort((left, right) => right.cursor_key.localeCompare(left.cursor_key))
              .slice(0, limit),
          };
        }
        if (sql.includes('FROM line_accounts')) {
          return {
            results: [{ id: 'account-1', channel_access_token: 'line-token' }],
          };
        }
        throw new Error(`Unexpected all query: ${sql}`);
      };
      return {
        all: vi.fn(() => queryAll()),
        bind: vi.fn((...values: unknown[]) => ({
          all: vi.fn(() => queryAll(values)),
          run: vi.fn(async () => {
            updates.push({ sql, values });
            return { meta: { changes: 1 } };
          }),
        })),
      };
    }),
  };
  return { db: db as unknown as D1Database, updates, preparedSql };
}

function makeFiles() {
  return {
    put: vi.fn(async () => undefined),
  };
}

describe('backfillIncomingImages', () => {
  test('保存できた画像だけ履歴行へ恒久 URL を追記し、404 の履歴は変更しない', async () => {
    const candidates: Candidate[] = [
      {
        scope: 'personal',
        id: 'log-new',
        content: JSON.stringify({
          lineMessageId: 'line-new',
          contentUrl: 'https://worker.example.com/api/chats/messages/log-new/media',
        }),
        line_message_id: 'line-new',
        line_account_id: 'account-1',
        created_at: '2026-07-31T10:00:00.000+09:00',
        cursor_key: '2026-07-31T10:00:00.000+09:00|personal|log-new',
      },
      {
        scope: 'group',
        id: 'group-old',
        content: '[画像]',
        line_message_id: 'line-old',
        line_account_id: 'account-1',
        created_at: '2026-07-20T10:00:00.000+09:00',
        cursor_key: '2026-07-20T10:00:00.000+09:00|group|group-old',
      },
    ];
    const { db, updates, preparedSql } = makeDb(candidates);
    const files = makeFiles();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(new ArrayBuffer(32), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await backfillIncomingImages({
        db,
        defaultAccessToken: 'default-token',
        workerUrl: 'https://worker.example.com',
        files: files as unknown as KVNamespace,
        fetch: fetchMock,
        limit: 2,
      });

      expect(result).toEqual({
        examined: 2,
        persisted: 1,
        unavailable: 1,
        failed: 0,
        nextCursor: candidates[1].cursor_key,
        hasMore: false,
      });
      expect(files.put).toHaveBeenCalledTimes(1);
      expect(preparedSql[0]).toContain("json_extract(content, '$.lineMessageId')");
      expect(updates).toHaveLength(1);
      expect(updates[0].sql).toContain('UPDATE messages_log');
      const updated = JSON.parse(String(updates[0].values[0]));
      expect(updated.originalContentUrl).toBe(
        'https://worker.example.com/images/incoming-account-1-line-new.jpg',
      );
      expect(updated.contentUrl).toContain('/api/chats/messages/log-new/media');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('カーソルより古い候補だけを処理し、次ページの有無を返す', async () => {
    const candidates: Candidate[] = Array.from({ length: 4 }, (_, index) => ({
      scope: 'personal' as const,
      id: `log-${index}`,
      content: '[画像]',
      line_message_id: `line-${index}`,
      line_account_id: 'account-1',
      created_at: `2026-07-${30 - index}T10:00:00.000+09:00`,
      cursor_key: `2026-07-${30 - index}T10:00:00.000+09:00|personal|log-${index}`,
    }));
    const { db } = makeDb(candidates);
    const files = makeFiles();
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(16), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );

    const result = await backfillIncomingImages({
      db,
      defaultAccessToken: 'default-token',
      workerUrl: 'https://worker.example.com',
      files: files as unknown as KVNamespace,
      fetch: fetchMock,
      cursor: candidates[0].cursor_key,
      limit: 2,
    });

    expect(result.examined).toBe(2);
    expect(result.persisted).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(candidates[2].cursor_key);
  });
});
