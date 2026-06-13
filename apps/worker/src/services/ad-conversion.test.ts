import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getActiveAdPlatforms,
  getRefTrackingWithClickIds,
  logAdConversion,
} from '@line-crm/db';
import { sendAdConversions } from './ad-conversion.js';

vi.mock('@line-crm/db', () => ({
  getActiveAdPlatforms: vi.fn(),
  getRefTrackingWithClickIds: vi.fn(),
  logAdConversion: vi.fn(),
}));

const mockedGetRefTrackingWithClickIds = vi.mocked(getRefTrackingWithClickIds);
const mockedGetActiveAdPlatforms = vi.mocked(getActiveAdPlatforms);
const mockedLogAdConversion = vi.mocked(logAdConversion);

describe('sendAdConversions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('stores only provider/status kind when an ad API returns a sensitive body', async () => {
    mockedGetRefTrackingWithClickIds.mockResolvedValue({
      id: 'ref-1',
      friend_id: 'friend-secret',
      ref_code: 'ref',
      source: null,
      campaign: null,
      medium: null,
      content: null,
      click_id: null,
      fbclid: 'fbclid-secret',
      gclid: null,
      ttclid: null,
      twclid: null,
      ip_address: '192.0.2.1',
      user_agent: 'secret-agent',
      first_clicked_at: '2026-05-01T00:00:00Z',
      created_at: '2026-05-01T00:00:00Z',
    });
    mockedGetActiveAdPlatforms.mockResolvedValue([
      {
        id: 'platform-1',
        name: 'meta',
        display_name: 'Meta',
        config: JSON.stringify({ pixel_id: 'pixel-1', access_token: 'meta-token-secret' }),
        is_active: 1,
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'meta-token-secret friend-secret fbclid-secret response-body-secret',
    });
    vi.stubGlobal('fetch', fetchMock);

    await sendAdConversions({} as D1Database, 'friend-secret', 'purchase', 1200);

    expect(mockedLogAdConversion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'meta_http_status_500',
      }),
    );
    const logged = mockedLogAdConversion.mock.calls[0][1].errorMessage ?? '';
    expect(logged).not.toContain('meta-token-secret');
    expect(logged).not.toContain('friend-secret');
    expect(logged).not.toContain('fbclid-secret');
    expect(logged).not.toContain('response-body-secret');
  });
});
