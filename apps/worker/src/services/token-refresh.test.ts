import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { refreshLineAccessTokens } from './token-refresh.js';
import { getLineAccounts, updateLineAccount } from '@line-crm/db';
import type { LineAccount } from '@line-crm/db';

vi.mock('@line-crm/db', () => ({
  getLineAccounts: vi.fn(),
  updateLineAccount: vi.fn(),
}));

function lineAccount(overrides: Partial<LineAccount> = {}): LineAccount {
  return {
    id: 'acc-secret-id',
    channel_id: 'channel-secret-id',
    name: 'Owner Secret Account',
    channel_access_token: 'old-secret-token',
    channel_secret: 'channel-secret-value',
    login_channel_id: null,
    login_channel_secret: null,
    liff_id: null,
    is_active: 1,
    country: null,
    role: null,
    display_order: 0,
    token_expires_at: null,
    created_at: '2026-06-01T00:00:00+09:00',
    updated_at: '2026-06-01T00:00:00+09:00',
    ...overrides,
  };
}

describe('refreshLineAccessTokens logging', () => {
  const db = {} as D1Database;

  beforeEach(() => {
    vi.mocked(getLineAccounts).mockResolvedValue([]);
    vi.mocked(updateLineAccount).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('does not log external response bodies or account names when token refresh fails', async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([lineAccount()]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('external-secret-body', { status: 500 })));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await refreshLineAccessTokens(db);

    const logged = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('line_token_api_http_status=500');
    expect(logged).not.toContain('external-secret-body');
    expect(logged).not.toContain('Owner Secret Account');
    expect(logged).not.toContain('channel-secret-value');
    expect(updateLineAccount).not.toHaveBeenCalled();
  });

  test('does not log account names or access tokens when token refresh succeeds', async () => {
    vi.mocked(getLineAccounts).mockResolvedValue([lineAccount()]);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      access_token: 'new-secret-token',
      expires_in: 3600,
      token_type: 'Bearer',
    })));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await refreshLineAccessTokens(db);

    expect(updateLineAccount).toHaveBeenCalledWith(db, 'acc-secret-id', expect.objectContaining({
      channel_access_token: 'new-secret-token',
    }));
    const logged = logSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('Token refreshed for active LINE account');
    expect(logged).not.toContain('Owner Secret Account');
    expect(logged).not.toContain('new-secret-token');
    expect(logged).not.toContain('acc-secret-id');
  });
});
