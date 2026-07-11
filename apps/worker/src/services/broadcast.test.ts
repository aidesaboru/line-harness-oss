import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBroadcastInsight,
  getBroadcastById,
  updateBroadcastLineRequestId,
  updateBroadcastStatus,
} from '@line-crm/db';
import { processBroadcastSend } from './broadcast.js';

vi.mock('@line-crm/db', () => ({
  createBroadcastInsight: vi.fn(),
  getBroadcastById: vi.fn(),
  getFriendsByTag: vi.fn(),
  jstNow: vi.fn(() => '2026-05-01T00:00:00+09:00'),
  updateBroadcastLineRequestId: vi.fn(),
  updateBroadcastStatus: vi.fn(),
}));

const mockedCreateBroadcastInsight = vi.mocked(createBroadcastInsight);
const mockedGetBroadcastById = vi.mocked(getBroadcastById);
const mockedUpdateBroadcastLineRequestId = vi.mocked(updateBroadcastLineRequestId);
const mockedUpdateBroadcastStatus = vi.mocked(updateBroadcastStatus);

describe('processBroadcastSend', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('logs only LINE status when a multicast batch fails', async () => {
    const broadcast = {
      id: 'broadcast-secret',
      title: 'secret broadcast',
      message_type: 'text',
      message_content: 'message-secret',
      target_type: 'tag',
      target_tag_id: 'tag-secret',
      status: 'draft',
      scheduled_at: null,
      sent_at: null,
      total_count: 0,
      success_count: 0,
      created_at: '2026-05-01T00:00:00+09:00',
      account_ids: null,
      dedup_priority: null,
      failed_account_ids: null,
      dedup_progress: null,
      batch_lock_at: null,
    };
    mockedGetBroadcastById.mockResolvedValue(broadcast as never);
    const lineClient = {
      multicast: vi.fn().mockRejectedValue(
        new Error('LINE API error: 500 Internal Server Error — token-secret U-secret body-secret'),
      ),
    };
    const db = {
      prepare: vi.fn((_sql: string) => ({
        bind: vi.fn(function bind() {
          return this;
        }),
        all: vi.fn(async () => ({
          results: [
            {
              id: 'friend-secret',
              line_user_id: 'U-secret',
            },
          ],
        })),
      })),
      batch: vi.fn(),
    } as unknown as D1Database;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await processBroadcastSend(db, lineClient as never, 'broadcast-secret');

    const logged = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('Multicast batch failed: line_http_status_500');
    expect(logged).not.toContain('broadcast-secret');
    expect(logged).not.toContain('friend-secret');
    expect(logged).not.toContain('U-secret');
    expect(logged).not.toContain('token-secret');
    expect(logged).not.toContain('body-secret');
    expect(mockedUpdateBroadcastLineRequestId).toHaveBeenCalled();
    expect(mockedCreateBroadcastInsight).toHaveBeenCalled();
    expect(mockedUpdateBroadcastStatus).toHaveBeenLastCalledWith(
      db,
      'broadcast-secret',
      'sent',
      { totalCount: 1, successCount: 0 },
    );
    errorSpy.mockRestore();
  });
});
