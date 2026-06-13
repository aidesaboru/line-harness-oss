import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAccountHealthLog,
  getLineAccounts,
} from '@line-crm/db';
import { checkAccountHealth } from './ban-monitor.js';

vi.mock('@line-crm/db', () => ({
  createAccountHealthLog: vi.fn(),
  getLineAccounts: vi.fn(),
}));

const mockedGetLineAccounts = vi.mocked(getLineAccounts);
const mockedCreateAccountHealthLog = vi.mocked(createAccountHealthLog);

describe('checkAccountHealth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it('logs only exception kind when a health check throws', async () => {
    mockedGetLineAccounts.mockResolvedValue([
      {
        id: 'account-secret',
        channel_id: 'channel-secret',
        name: 'secret account',
        channel_access_token: 'token-secret',
        channel_secret: 'secret',
        login_channel_id: null,
        login_channel_secret: null,
        liff_id: null,
        is_active: 1,
        country: null,
        role: null,
        display_order: 0,
        token_expires_at: null,
        created_at: '2026-05-01T00:00:00+09:00',
        updated_at: '2026-05-01T00:00:00+09:00',
      },
    ]);
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error('D1 secret body account-secret token-secret');
          },
        }),
      }),
    } as unknown as D1Database;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await checkAccountHealth(db);

    const logged = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('ヘルスチェックエラー: Error');
    expect(logged).not.toContain('D1 secret body');
    expect(logged).not.toContain('account-secret');
    expect(logged).not.toContain('token-secret');
    expect(mockedCreateAccountHealthLog).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('omits account identifiers from BAN-risk console logs', async () => {
    mockedGetLineAccounts.mockResolvedValue([
      {
        id: 'account-secret',
        channel_id: 'channel-secret',
        name: 'secret account',
        channel_access_token: 'token-secret',
        channel_secret: 'secret',
        login_channel_id: null,
        login_channel_secret: null,
        liff_id: null,
        is_active: 1,
        country: null,
        role: null,
        display_order: 0,
        token_expires_at: null,
        created_at: '2026-05-01T00:00:00+09:00',
        updated_at: '2026-05-01T00:00:00+09:00',
      },
    ]);
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ count: 0 }),
        }),
      }),
    } as unknown as D1Database;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await checkAccountHealth(db);

    const logged = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('BAN検知: active account returned 403');
    expect(logged).not.toContain('account-secret');
    expect(logged).not.toContain('token-secret');
    expect(mockedCreateAccountHealthLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lineAccountId: 'account-secret', errorCode: 403, riskLevel: 'danger' }),
    );
    errorSpy.mockRestore();
  });
});
