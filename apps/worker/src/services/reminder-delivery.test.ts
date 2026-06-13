import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeReminderIfDone,
  getDueReminderDeliveries,
  getFriendById,
} from '@line-crm/db';
import { processReminderDeliveries } from './reminder-delivery.js';

vi.mock('@line-crm/db', () => ({
  completeReminderIfDone: vi.fn(),
  getDueReminderDeliveries: vi.fn(),
  getFriendById: vi.fn(),
  jstNow: vi.fn(() => '2026-05-01T00:00:00+09:00'),
}));

vi.mock('./stealth.js', () => ({
  addJitter: vi.fn(() => 0),
  sleep: vi.fn(async () => undefined),
}));

const mockedGetDueReminderDeliveries = vi.mocked(getDueReminderDeliveries);
const mockedGetFriendById = vi.mocked(getFriendById);
const mockedCompleteReminderIfDone = vi.mocked(completeReminderIfDone);

describe('processReminderDeliveries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('logs only exception kind when a reminder delivery fails', async () => {
    mockedGetDueReminderDeliveries.mockResolvedValue([
      {
        id: 'friend-reminder-secret',
        friend_id: 'friend-secret',
        reminder_id: 'reminder-secret',
        target_date: '2026-05-01T00:00:00+09:00',
        status: 'active',
        created_at: '2026-05-01T00:00:00+09:00',
        updated_at: '2026-05-01T00:00:00+09:00',
        steps: [
          {
            id: 'step-secret',
            reminder_id: 'reminder-secret',
            offset_minutes: 0,
            message_type: 'text',
            message_content: 'message-secret',
            created_at: '2026-05-01T00:00:00+09:00',
          },
        ],
      },
    ]);
    mockedGetFriendById.mockRejectedValue(
      new Error('D1 secret body friend-secret reminder-secret token-abc'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await processReminderDeliveries({} as D1Database, { pushMessage: vi.fn() } as never);

    const logged = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('リマインダ配信エラー: Error');
    expect(logged).not.toContain('D1 secret body');
    expect(logged).not.toContain('friend-secret');
    expect(logged).not.toContain('reminder-secret');
    expect(logged).not.toContain('token-abc');
    expect(mockedCompleteReminderIfDone).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
