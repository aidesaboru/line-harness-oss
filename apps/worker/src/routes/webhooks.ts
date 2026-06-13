import { Hono } from 'hono';
import {
  getIncomingWebhooks,
  getIncomingWebhookById,
  createIncomingWebhook,
  updateIncomingWebhook,
  deleteIncomingWebhook,
  getOutgoingWebhooks,
  getOutgoingWebhookById,
  createOutgoingWebhook,
  updateOutgoingWebhook,
  deleteOutgoingWebhook,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const webhooks = new Hono<Env>();

const MIN_SECRET_LENGTH = 32;
const MAX_SECRET_LENGTH = 4096;
const WEBHOOK_NAME_MAX_LENGTH = 120;
const WEBHOOK_SOURCE_TYPE_MAX_LENGTH = 64;
const WEBHOOK_URL_MAX_LENGTH = 2048;
const WEBHOOK_ID_MAX_LENGTH = 128;
const WEBHOOK_EVENT_TYPES_MAX_COUNT = 32;
const WEBHOOK_EVENT_TYPE_MAX_LENGTH = 128;
const WEBHOOK_TOKEN_PATTERN = /^[!-~]+$/;

type ParsedIncomingCreateBody =
  | { ok: true; body: { name: string; sourceType?: string; secret: string } }
  | { ok: false; error: string };
type ParsedIncomingUpdateBody =
  | { ok: true; body: { name?: string; sourceType?: string; secret?: string; isActive?: boolean } }
  | { ok: false; error: string };
type ParsedOutgoingCreateBody =
  | { ok: true; body: { name: string; url: string; eventTypes: string[]; secret: string } }
  | { ok: false; error: string };
type ParsedOutgoingUpdateBody =
  | { ok: true; body: { name?: string; url?: string; eventTypes?: string[]; secret?: string; isActive?: boolean } }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown | null> {
  return c.req.json().catch(() => null);
}

function validateSecret(secret: unknown): string | null {
  if (typeof secret !== 'string') {
    return 'secret must be a string';
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return `secret must be at least ${MIN_SECRET_LENGTH} characters`;
  }
  if (secret.length > MAX_SECRET_LENGTH) {
    return 'secret is too long';
  }
  return null;
}

function validateHttpsUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0) {
    return 'url is required';
  }
  if (url.length > WEBHOOK_URL_MAX_LENGTH) return 'url is too long';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'url must be a valid absolute URL';
  }
  if (parsed.protocol !== 'https:') {
    return 'url must use https:// scheme';
  }
  return null;
}

function parseWebhookName(raw: unknown, required: boolean): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw == null) return required ? { ok: false, error: 'name is required' } : { ok: true };
  if (typeof raw !== 'string') return { ok: false, error: 'name must be a string' };
  const value = raw.trim();
  if (!value) return { ok: false, error: 'name is required' };
  if (value.length > WEBHOOK_NAME_MAX_LENGTH) return { ok: false, error: 'name is too long' };
  return { ok: true, value };
}

function parseWebhookSourceType(raw: unknown): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw == null) return { ok: true };
  if (typeof raw !== 'string') return { ok: false, error: 'sourceType must be a string' };
  const value = raw.trim();
  if (!value) return { ok: true };
  if (value.length > WEBHOOK_SOURCE_TYPE_MAX_LENGTH || !WEBHOOK_TOKEN_PATTERN.test(value)) {
    return { ok: false, error: 'sourceType is invalid' };
  }
  return { ok: true, value };
}

function parseWebhookId(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'webhookId must be a string' };
  const value = raw.trim();
  if (!value || value.length > WEBHOOK_ID_MAX_LENGTH || !WEBHOOK_TOKEN_PATTERN.test(value)) {
    return { ok: false, error: 'webhookId is invalid' };
  }
  return { ok: true, value };
}

function parseWebhookSecret(raw: unknown, required: boolean): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw == null) return required ? { ok: false, error: 'secret is required' } : { ok: true };
  if (typeof raw !== 'string') return { ok: false, error: 'secret must be a string' };
  const value = raw.trim();
  const secretError = validateSecret(value);
  if (secretError) return { ok: false, error: secretError };
  return { ok: true, value };
}

function parseWebhookUrl(raw: unknown, required: boolean): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw == null) return required ? { ok: false, error: 'url is required' } : { ok: true };
  if (typeof raw !== 'string') return { ok: false, error: 'url must be a string' };
  const value = raw.trim();
  const urlError = validateHttpsUrl(value);
  if (urlError) return { ok: false, error: urlError };
  return { ok: true, value };
}

function parseWebhookEventTypes(raw: unknown, required: boolean): { ok: true; value?: string[] } | { ok: false; error: string } {
  if (raw === undefined) return required ? { ok: false, error: 'eventTypes is required' } : { ok: true };
  if (!Array.isArray(raw)) return { ok: false, error: 'eventTypes must be an array' };
  if (raw.length > WEBHOOK_EVENT_TYPES_MAX_COUNT) return { ok: false, error: 'eventTypes has too many items' };
  const value: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: 'eventTypes must contain strings' };
    const eventType = item.trim();
    if (
      !eventType ||
      eventType.length > WEBHOOK_EVENT_TYPE_MAX_LENGTH ||
      !WEBHOOK_TOKEN_PATTERN.test(eventType)
    ) {
      return { ok: false, error: 'eventTypes contains an invalid value' };
    }
    value.push(eventType);
  }
  return { ok: true, value };
}

function parseIncomingCreateBody(raw: unknown): ParsedIncomingCreateBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseWebhookName(raw.name, true);
  if (!name.ok) return name;
  const sourceType = parseWebhookSourceType(raw.sourceType);
  if (!sourceType.ok) return sourceType;
  const secret = parseWebhookSecret(raw.secret, true);
  if (!secret.ok) return secret;
  return { ok: true, body: { name: name.value!, sourceType: sourceType.value, secret: secret.value! } };
}

function parseIncomingUpdateBody(raw: unknown): ParsedIncomingUpdateBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseWebhookName(raw.name, false);
  if (!name.ok) return name;
  const sourceType = parseWebhookSourceType(raw.sourceType);
  if (!sourceType.ok) return sourceType;
  const secret = parseWebhookSecret(raw.secret, false);
  if (!secret.ok) return secret;
  if (raw.isActive !== undefined && typeof raw.isActive !== 'boolean') {
    return { ok: false, error: 'isActive must be a boolean' };
  }
  return {
    ok: true,
    body: { name: name.value, sourceType: sourceType.value, secret: secret.value, isActive: raw.isActive },
  };
}

function parseOutgoingCreateBody(raw: unknown): ParsedOutgoingCreateBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseWebhookName(raw.name, true);
  if (!name.ok) return name;
  const url = parseWebhookUrl(raw.url, true);
  if (!url.ok) return url;
  const eventTypes = parseWebhookEventTypes(raw.eventTypes === undefined ? [] : raw.eventTypes, false);
  if (!eventTypes.ok) return eventTypes;
  const secret = parseWebhookSecret(raw.secret, true);
  if (!secret.ok) return secret;
  return {
    ok: true,
    body: { name: name.value!, url: url.value!, eventTypes: eventTypes.value ?? [], secret: secret.value! },
  };
}

function parseOutgoingUpdateBody(raw: unknown): ParsedOutgoingUpdateBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const name = parseWebhookName(raw.name, false);
  if (!name.ok) return name;
  const url = parseWebhookUrl(raw.url, false);
  if (!url.ok) return url;
  const eventTypes = parseWebhookEventTypes(raw.eventTypes, false);
  if (!eventTypes.ok) return eventTypes;
  const secret = parseWebhookSecret(raw.secret, false);
  if (!secret.ok) return secret;
  if (raw.isActive !== undefined && typeof raw.isActive !== 'boolean') {
    return { ok: false, error: 'isActive must be a boolean' };
  }
  return {
    ok: true,
    body: {
      name: name.value,
      url: url.value,
      eventTypes: eventTypes.value,
      secret: secret.value,
      isActive: raw.isActive,
    },
  };
}

function webhookRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

// Constant-time hex-string compare to avoid timing oracles.
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function computeHmacSha256Hex(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ========== 受信Webhook ==========

webhooks.get('/api/webhooks/incoming', requireRole('owner', 'admin'), async (c) => {
  try {
    const items = await getIncomingWebhooks(c.env.DB);
    return c.json({
      success: true,
      data: items.map((w) => ({
        id: w.id,
        name: w.name,
        sourceType: w.source_type,
        hasSecret: Boolean(w.secret && w.secret.length >= MIN_SECRET_LENGTH),
        isActive: Boolean(w.is_active),
        createdAt: w.created_at,
        updatedAt: w.updated_at,
      })),
    });
  } catch (err) {
    console.error(`GET /api/webhooks/incoming error: ${webhookRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

webhooks.post('/api/webhooks/incoming', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseIncomingCreateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;
    const item = await createIncomingWebhook(c.env.DB, {
      name: body.name,
      sourceType: body.sourceType,
      secret: body.secret,
    });
    return c.json(
      {
        success: true,
        data: {
          id: item.id,
          name: item.name,
          sourceType: item.source_type,
          // secret is returned exactly once on create so the operator can copy it.
          // Subsequent GETs never expose it.
          secret: item.secret,
          isActive: Boolean(item.is_active),
          createdAt: item.created_at,
        },
      },
      201,
    );
  } catch (err) {
    console.error(`POST /api/webhooks/incoming error: ${webhookRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

webhooks.put('/api/webhooks/incoming/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseWebhookId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parseIncomingUpdateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;
    // Activation gate: never re-enable a webhook whose post-update secret
    // would still be invalid. Otherwise migration 034 can be bypassed by
    // toggling isActive without touching the legacy null/short secret.
    if (body.isActive === true) {
      const existing = await getIncomingWebhookById(c.env.DB, id.value);
      if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
      const effectiveSecret = body.secret ?? existing.secret;
      if (!effectiveSecret || effectiveSecret.length < MIN_SECRET_LENGTH) {
        return c.json(
          {
            success: false,
            error: `Cannot activate webhook: secret must be at least ${MIN_SECRET_LENGTH} characters. Update the secret first.`,
          },
          400,
        );
      }
    }
    await updateIncomingWebhook(c.env.DB, id.value, body);
    const updated = await getIncomingWebhookById(c.env.DB, id.value);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        sourceType: updated.source_type,
        hasSecret: Boolean(updated.secret && updated.secret.length >= MIN_SECRET_LENGTH),
        isActive: Boolean(updated.is_active),
      },
    });
  } catch (err) {
    console.error(`PUT /api/webhooks/incoming/:id error: ${webhookRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

webhooks.delete('/api/webhooks/incoming/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseWebhookId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteIncomingWebhook(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/webhooks/incoming/:id error: ${webhookRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 送信Webhook ==========

webhooks.get('/api/webhooks/outgoing', requireRole('owner', 'admin'), async (c) => {
  try {
    const items = await getOutgoingWebhooks(c.env.DB);
    return c.json({
      success: true,
      data: items.map((w) => ({
        id: w.id,
        name: w.name,
        url: w.url,
        eventTypes: JSON.parse(w.event_types),
        hasSecret: Boolean(w.secret && w.secret.length >= MIN_SECRET_LENGTH),
        isActive: Boolean(w.is_active),
        createdAt: w.created_at,
        updatedAt: w.updated_at,
      })),
    });
  } catch (err) {
    console.error(`GET /api/webhooks/outgoing error: ${webhookRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

webhooks.post('/api/webhooks/outgoing', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseOutgoingCreateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;
    const item = await createOutgoingWebhook(c.env.DB, {
      name: body.name,
      url: body.url,
      eventTypes: body.eventTypes,
      secret: body.secret,
    });
    return c.json(
      {
        success: true,
        data: {
          id: item.id,
          name: item.name,
          url: item.url,
          eventTypes: JSON.parse(item.event_types),
          // Returned exactly once on create.
          secret: item.secret,
          isActive: Boolean(item.is_active),
          createdAt: item.created_at,
        },
      },
      201,
    );
  } catch (err) {
    console.error(`POST /api/webhooks/outgoing error: ${webhookRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

webhooks.put('/api/webhooks/outgoing/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseWebhookId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parseOutgoingUpdateBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;
    // Activation gate: a PUT that re-enables an outgoing webhook must leave
    // the row with both a valid secret AND an https url even after the
    // partial update. Without this, migration 034 can be bypassed by
    // sending {isActive:true} on a legacy http:// or secret-less row.
    if (body.isActive === true) {
      const existing = await getOutgoingWebhookById(c.env.DB, id.value);
      if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
      const effectiveSecret = body.secret ?? existing.secret;
      const effectiveUrl = body.url ?? existing.url;
      if (!effectiveSecret || effectiveSecret.length < MIN_SECRET_LENGTH) {
        return c.json(
          {
            success: false,
            error: `Cannot activate webhook: secret must be at least ${MIN_SECRET_LENGTH} characters. Update the secret first.`,
          },
          400,
        );
      }
      const urlError = validateHttpsUrl(effectiveUrl);
      if (urlError) {
        return c.json(
          { success: false, error: `Cannot activate webhook: ${urlError}` },
          400,
        );
      }
    }
    await updateOutgoingWebhook(c.env.DB, id.value, body);
    const updated = await getOutgoingWebhookById(c.env.DB, id.value);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: {
        id: updated.id,
        name: updated.name,
        url: updated.url,
        eventTypes: JSON.parse(updated.event_types),
        hasSecret: Boolean(updated.secret && updated.secret.length >= MIN_SECRET_LENGTH),
        isActive: Boolean(updated.is_active),
      },
    });
  } catch (err) {
    console.error(`PUT /api/webhooks/outgoing/:id error: ${webhookRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

webhooks.delete('/api/webhooks/outgoing/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseWebhookId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteOutgoingWebhook(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/webhooks/outgoing/:id error: ${webhookRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 受信Webhookエンドポイント (外部システムからの受信) ==========

webhooks.post('/api/webhooks/incoming/:id/receive', async (c) => {
  try {
    const id = parseWebhookId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const wh = await getIncomingWebhookById(c.env.DB, id.value);
    if (!wh || !wh.is_active) {
      return c.json({ success: false, error: 'Webhook not found or inactive' }, 404);
    }
    if (!wh.secret || wh.secret.length < MIN_SECRET_LENGTH) {
      // Should never happen post-migration, but fail closed.
      return c.json({ success: false, error: 'Webhook is not configured for secure delivery' }, 503);
    }

    const signatureHeader = c.req.header('X-Webhook-Signature') ?? '';
    if (!signatureHeader) {
      return c.json({ success: false, error: 'X-Webhook-Signature header is required' }, 401);
    }

    const rawBody = await c.req.text();
    const expected = await computeHmacSha256Hex(wh.secret, rawBody);
    if (!safeEqualHex(signatureHeader.toLowerCase(), expected)) {
      return c.json({ success: false, error: 'Invalid signature' }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400);
    }

    const { fireEvent } = await import('../services/event-bus.js');
    const eventType = `incoming_webhook.${wh.source_type}`;
    await fireEvent(c.env.DB, eventType, {
      eventData: { webhookId: wh.id, source: wh.source_type, payload },
    });

    return c.json({ success: true, data: { received: true, source: wh.source_type } });
  } catch (err) {
    console.error(`POST /api/webhooks/incoming/:id/receive error: ${webhookRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { webhooks };
