import { Hono } from 'hono';
import {
  getAdPlatforms,
  getAdPlatformById,
  createAdPlatform,
  updateAdPlatform,
  deleteAdPlatform,
  getAdConversionLogs,
  getAdPlatformByName,
} from '@line-crm/db';
import { sendAdConversions } from '../services/ad-conversion.js';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

function maskConfig(config: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && value.length > 8) {
      masked[key] = value.slice(0, 4) + '****' + value.slice(-4);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

const adPlatforms = new Hono<Env>();
const AD_PLATFORM_NAMES = ['meta', 'x', 'google', 'tiktok'] as const;
const AD_PLATFORM_DISPLAY_NAME_MAX_LENGTH = 120;
const AD_PLATFORM_CONFIG_MAX_BYTES = 16 * 1024;
const AD_PLATFORM_CONFIG_MAX_KEYS = 50;
const AD_PLATFORM_CONFIG_KEY_MAX_LENGTH = 64;
const AD_PLATFORM_CONFIG_VALUE_MAX_LENGTH = 4096;
const AD_PLATFORM_REF_MAX_LENGTH = 128;
const AD_PLATFORM_CONFIG_KEY_PATTERN = /^[A-Za-z0-9_.-]+$/;
const AD_PLATFORM_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;

type AdPlatformName = (typeof AD_PLATFORM_NAMES)[number];
type AdPlatformConfigPayload = Record<string, string | number | boolean | null>;
type ParsedCreateAdPlatformBody =
  | { ok: true; body: { name: AdPlatformName; displayName?: string | null; config: AdPlatformConfigPayload } }
  | { ok: false; error: string };
type ParsedUpdateAdPlatformBody =
  | { ok: true; body: { name?: AdPlatformName; displayName?: string | null; config?: AdPlatformConfigPayload; isActive?: boolean } }
  | { ok: false; error: string };
type ParsedAdPlatformTestBody =
  | { ok: true; body: { platform: AdPlatformName; eventName: string; friendId?: string } }
  | { ok: false; error: string };

function clampLimit(raw: string | undefined, fallback = 50): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(n)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown | null> {
  return c.req.json().catch(() => null);
}

function parseAdPlatformName(raw: unknown, required: boolean): { ok: true; value?: AdPlatformName } | { ok: false; error: string } {
  if (raw == null) return required ? { ok: false, error: 'name is required' } : { ok: true };
  if (typeof raw !== 'string') return { ok: false, error: 'name must be a string' };
  const value = raw.trim();
  if (!AD_PLATFORM_NAMES.includes(value as AdPlatformName)) {
    return { ok: false, error: `name must be one of: ${AD_PLATFORM_NAMES.join(', ')}` };
  }
  return { ok: true, value: value as AdPlatformName };
}

function parseDisplayName(raw: unknown): { ok: true; value?: string | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'displayName must be a string' };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > AD_PLATFORM_DISPLAY_NAME_MAX_LENGTH) return { ok: false, error: 'displayName is too long' };
  return { ok: true, value };
}

function parseAdPlatformConfig(raw: unknown, required: boolean): { ok: true; value?: AdPlatformConfigPayload } | { ok: false; error: string } {
  if (raw === undefined) return required ? { ok: false, error: 'config is required' } : { ok: true };
  if (!isRecord(raw)) return { ok: false, error: 'config must be an object' };

  const entries = Object.entries(raw);
  if (entries.length === 0 && required) return { ok: false, error: 'config is required' };
  if (entries.length > AD_PLATFORM_CONFIG_MAX_KEYS) return { ok: false, error: 'config has too many keys' };

  const value: AdPlatformConfigPayload = {};
  for (const [key, configValue] of entries) {
    if (
      !key ||
      key.length > AD_PLATFORM_CONFIG_KEY_MAX_LENGTH ||
      !AD_PLATFORM_CONFIG_KEY_PATTERN.test(key) ||
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype'
    ) {
      return { ok: false, error: 'config key is invalid' };
    }
    if (configValue === null || typeof configValue === 'boolean') {
      value[key] = configValue;
      continue;
    }
    if (typeof configValue === 'number') {
      if (!Number.isFinite(configValue)) return { ok: false, error: 'config number must be finite' };
      value[key] = configValue;
      continue;
    }
    if (typeof configValue === 'string') {
      if (configValue.length > AD_PLATFORM_CONFIG_VALUE_MAX_LENGTH) {
        return { ok: false, error: 'config value is too long' };
      }
      value[key] = configValue;
      continue;
    }
    return { ok: false, error: 'config values must be primitive' };
  }

  const configBytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (configBytes > AD_PLATFORM_CONFIG_MAX_BYTES) return { ok: false, error: 'config is too large' };
  return { ok: true, value };
}

function parseVisibleAsciiToken(raw: unknown, key: string, required: boolean): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw == null) return required ? { ok: false, error: `${key} is required` } : { ok: true };
  if (typeof raw !== 'string') return { ok: false, error: `${key} must be a string` };
  const value = raw.trim();
  if (!value) return required ? { ok: false, error: `${key} is required` } : { ok: true };
  if (value.length > AD_PLATFORM_REF_MAX_LENGTH || !AD_PLATFORM_VISIBLE_ASCII_PATTERN.test(value)) {
    return { ok: false, error: `${key} is invalid` };
  }
  return { ok: true, value };
}

function parseAdPlatformPathId(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const id = parseVisibleAsciiToken(raw, 'adPlatformId', true);
  return id.ok ? { ok: true, value: id.value! } : id;
}

function parseCreateAdPlatformBody(raw: unknown): ParsedCreateAdPlatformBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseAdPlatformName(raw.name, true);
  if (!name.ok) return name;
  const displayName = parseDisplayName(raw.displayName);
  if (!displayName.ok) return displayName;
  const config = parseAdPlatformConfig(raw.config, true);
  if (!config.ok) return config;

  return { ok: true, body: { name: name.value!, displayName: displayName.value, config: config.value! } };
}

function parseUpdateAdPlatformBody(raw: unknown): ParsedUpdateAdPlatformBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseAdPlatformName(raw.name, false);
  if (!name.ok) return name;
  const displayName = parseDisplayName(raw.displayName);
  if (!displayName.ok) return displayName;
  const config = parseAdPlatformConfig(raw.config, false);
  if (!config.ok) return config;
  if (raw.isActive !== undefined && typeof raw.isActive !== 'boolean') {
    return { ok: false, error: 'isActive must be boolean' };
  }

  return {
    ok: true,
    body: {
      name: name.value,
      displayName: displayName.value,
      config: config.value,
      isActive: raw.isActive,
    },
  };
}

function parseAdPlatformTestBody(raw: unknown): ParsedAdPlatformTestBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const platform = parseAdPlatformName(raw.platform, true);
  if (!platform.ok) return platform;
  const eventName = parseVisibleAsciiToken(raw.eventName, 'eventName', true);
  if (!eventName.ok) return eventName;
  const friendId = parseVisibleAsciiToken(raw.friendId, 'friendId', false);
  if (!friendId.ok) return friendId;

  return { ok: true, body: { platform: platform.value!, eventName: eventName.value!, friendId: friendId.value } };
}

// GET /api/ad-platforms - list all
adPlatforms.get('/api/ad-platforms', requireRole('owner', 'admin'), async (c) => {
  try {
    const items = await getAdPlatforms(c.env.DB);
    return c.json({
      success: true,
      data: items.map((p) => ({
        id: p.id,
        name: p.name,
        displayName: p.display_name,
        config: maskConfig(JSON.parse(p.config)),
        isActive: !!p.is_active,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/ad-platforms error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/ad-platforms - create
adPlatforms.post('/api/ad-platforms', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseCreateAdPlatformBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    const platform = await createAdPlatform(c.env.DB, {
      name: body.name,
      displayName: body.displayName,
      config: body.config,
    });

    return c.json({
      success: true,
      data: {
        id: platform.id,
        name: platform.name,
        displayName: platform.display_name,
        config: JSON.parse(platform.config),
        isActive: !!platform.is_active,
        createdAt: platform.created_at,
        updatedAt: platform.updated_at,
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/ad-platforms error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/ad-platforms/:id - update
adPlatforms.put('/api/ad-platforms/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseAdPlatformPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parseUpdateAdPlatformBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);

    const platform = await updateAdPlatform(c.env.DB, id.value, parsed.body);
    if (!platform) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        id: platform.id,
        name: platform.name,
        displayName: platform.display_name,
        config: JSON.parse(platform.config),
        isActive: !!platform.is_active,
        createdAt: platform.created_at,
        updatedAt: platform.updated_at,
      },
    });
  } catch (err) {
    console.error('PUT /api/ad-platforms/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/ad-platforms/test - test conversion send (must be before :id routes)
adPlatforms.post('/api/ad-platforms/test', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseAdPlatformTestBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    const platform = await getAdPlatformByName(c.env.DB, body.platform);
    if (!platform) {
      return c.json({ success: false, error: `Platform "${body.platform}" not found or inactive` }, 404);
    }

    if (body.friendId) {
      await sendAdConversions(c.env.DB, body.friendId, body.eventName);
      return c.json({ success: true, data: { message: 'Test conversion sent via full pipeline' } });
    }

    return c.json({
      success: true,
      data: {
        message: `Platform "${body.platform}" is configured and active. Provide friendId to send a test conversion.`,
      },
    });
  } catch (err) {
    console.error('POST /api/ad-platforms/test error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/ad-platforms/:id - delete
adPlatforms.delete('/api/ad-platforms/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseAdPlatformPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteAdPlatform(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/ad-platforms/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/ad-platforms/:id/logs - conversion send logs
adPlatforms.get('/api/ad-platforms/:id/logs', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseAdPlatformPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const limit = clampLimit(c.req.query('limit'), 50);
    const logs = await getAdConversionLogs(c.env.DB, id.value, limit);

    return c.json({
      success: true,
      data: logs.map((l) => ({
        id: l.id,
        adPlatformId: l.ad_platform_id,
        friendId: l.friend_id,
        eventName: l.event_name,
        clickId: l.click_id,
        clickIdType: l.click_id_type,
        status: l.status,
        errorMessage: l.error_message,
        createdAt: l.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/ad-platforms/:id/logs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { adPlatforms };
