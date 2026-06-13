import { Hono } from 'hono';
import {
  getStripeEvents,
  getStripeEventByStripeId,
  createStripeEvent,
  jstNow,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const stripe = new Hono<Env>();
const STRIPE_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const STRIPE_SIGNATURE_HEADER_MAX_LENGTH = 4096;
const STRIPE_ID_MAX_LENGTH = 255;
const STRIPE_EVENT_TYPE_MAX_LENGTH = 128;
const STRIPE_CURRENCY_MAX_LENGTH = 16;
const STRIPE_METADATA_MAX_KEYS = 50;
const STRIPE_METADATA_KEY_MAX_LENGTH = 64;
const STRIPE_METADATA_VALUE_MAX_LENGTH = 500;

function clampLimit(raw: string | undefined, fallback = 100): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(n)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

interface StripeWebhookBody {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      amount?: number;
      currency?: string;
      metadata?: Record<string, string>;
      customer?: string;
      status?: string;
    };
  };
}

type ParsedStripeWebhookBody =
  | { ok: true; body: StripeWebhookBody }
  | { ok: false; error: string };

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function parseOptionalBoundedString(raw: unknown, maxLength: number): string | undefined | null {
  if (raw == null) return undefined;
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > maxLength) return null;
  return value;
}

function parseStripeMetadata(raw: unknown): Record<string, string> | undefined | null {
  if (raw == null) return undefined;
  if (!isRecord(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > STRIPE_METADATA_MAX_KEYS) return null;

  const metadata: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!key || key.length > STRIPE_METADATA_KEY_MAX_LENGTH) return null;
    if (typeof value !== 'string' || value.length > STRIPE_METADATA_VALUE_MAX_LENGTH) return null;
    metadata[key] = value;
  }
  return metadata;
}

function parseStripeWebhookBody(raw: unknown): ParsedStripeWebhookBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid Stripe payload' };

  const id = parseOptionalBoundedString(raw.id, STRIPE_ID_MAX_LENGTH);
  const type = parseOptionalBoundedString(raw.type, STRIPE_EVENT_TYPE_MAX_LENGTH);
  if (!id || !type) return { ok: false, error: 'Invalid Stripe event' };

  if (!isRecord(raw.data) || !isRecord(raw.data.object)) {
    return { ok: false, error: 'Invalid Stripe object' };
  }

  const objectId = parseOptionalBoundedString(raw.data.object.id, STRIPE_ID_MAX_LENGTH);
  if (!objectId) return { ok: false, error: 'Invalid Stripe object' };

  let amount: number | undefined;
  const amountRaw = raw.data.object.amount;
  if (amountRaw != null) {
    if (typeof amountRaw !== 'number' || !Number.isSafeInteger(amountRaw) || amountRaw < 0) {
      return { ok: false, error: 'Invalid Stripe amount' };
    }
    amount = amountRaw;
  }

  const currency = parseOptionalBoundedString(raw.data.object.currency, STRIPE_CURRENCY_MAX_LENGTH);
  if (currency === null) return { ok: false, error: 'Invalid Stripe currency' };

  const metadata = parseStripeMetadata(raw.data.object.metadata);
  if (metadata === null) return { ok: false, error: 'Invalid Stripe metadata' };

  const customer = parseOptionalBoundedString(raw.data.object.customer, STRIPE_ID_MAX_LENGTH);
  if (customer === null) return { ok: false, error: 'Invalid Stripe customer' };

  const status = parseOptionalBoundedString(raw.data.object.status, STRIPE_ID_MAX_LENGTH);
  if (status === null) return { ok: false, error: 'Invalid Stripe status' };

  return {
    ok: true,
    body: {
      id,
      type,
      data: {
        object: {
          id: objectId,
          amount,
          currency,
          metadata,
          customer,
          status,
        },
      },
    },
  };
}

function parseStripeWebhookJson(rawBody: string): ParsedStripeWebhookBody {
  try {
    return parseStripeWebhookBody(JSON.parse(rawBody) as unknown);
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }
}

function rawBodyByteLength(rawBody: string): number {
  return new TextEncoder().encode(rawBody).byteLength;
}

// ========== Stripeイベント一覧 ==========

stripe.get('/api/integrations/stripe/events', requireRole('owner', 'admin'), async (c) => {
  try {
    const friendId = c.req.query('friendId') ?? undefined;
    const eventType = c.req.query('eventType') ?? undefined;
    const limit = clampLimit(c.req.query('limit'), 100);
    const items = await getStripeEvents(c.env.DB, { friendId, eventType, limit });
    return c.json({
      success: true,
      data: items.map((e) => ({
        id: e.id,
        stripeEventId: e.stripe_event_id,
        eventType: e.event_type,
        friendId: e.friend_id,
        amount: e.amount,
        currency: e.currency,
        metadata: e.metadata ? JSON.parse(e.metadata) : null,
        processedAt: e.processed_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/stripe/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Stripe Webhookレシーバー ==========

/** Stripe署名検証 */
async function verifyStripeSignature(secret: string, rawBody: string, sigHeader: string): Promise<boolean> {
  if (!sigHeader || sigHeader.length > STRIPE_SIGNATURE_HEADER_MAX_LENGTH) return false;
  // Stripe署名形式: t=timestamp,v1=signature
  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => {
      const [k, ...v] = p.split('=');
      return [k, v.join('=')];
    }),
  );
  const timestamp = parts.t;
  const expectedSig = parts.v1?.toLowerCase();
  if (!timestamp || !expectedSig) return false;
  if (!/^\d{1,20}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(expectedSig)) return false;

  const encoder = new TextEncoder();
  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return safeEqualHex(computedSig, expectedSig);
}

stripe.post('/api/integrations/stripe/webhook', async (c) => {
  try {
    const stripeSecret = (c.env as unknown as Record<string, string | undefined>).STRIPE_WEBHOOK_SECRET;
    const contentLength = Number(c.req.header('Content-Length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
      return c.json({ success: false, error: 'Stripe payload too large' }, 413);
    }

    const rawBody = await c.req.text();
    if (rawBodyByteLength(rawBody) > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
      return c.json({ success: false, error: 'Stripe payload too large' }, 413);
    }

    if (stripeSecret) {
      // 署名検証モード（本番環境）
      const sigHeader = c.req.header('Stripe-Signature') ?? '';

      const valid = await verifyStripeSignature(stripeSecret, rawBody, sigHeader);
      if (!valid) {
        return c.json({ success: false, error: 'Stripe signature verification failed' }, 401);
      }
    }

    const parsed = parseStripeWebhookJson(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    // 冪等性チェック
    const existing = await getStripeEventByStripeId(c.env.DB, body.id);
    if (existing) {
      return c.json({ success: true, data: { message: 'Already processed' } });
    }

    const obj = body.data.object;
    const db = c.env.DB;

    // メタデータからfriendIdを取得（Stripeのメタデータにline_friend_idを設定している想定）
    const friendId = obj.metadata?.line_friend_id ?? null;

    // イベントを記録
    const event = await createStripeEvent(db, {
      stripeEventId: body.id,
      eventType: body.type,
      friendId: friendId ?? undefined,
      amount: obj.amount,
      currency: obj.currency,
      metadata: JSON.stringify(obj.metadata ?? {}),
    });

    // 決済成功時の自動処理
    if (body.type === 'payment_intent.succeeded' && friendId) {
      const { applyScoring } = await import('@line-crm/db');
      await applyScoring(db, friendId, 'purchase');

      // 自動タグ付け（product_idベース）
      const productId = obj.metadata?.product_id;
      if (productId) {
        const tag = await db
          .prepare(`SELECT id FROM tags WHERE name = ?`)
          .bind(`purchased_${productId}`)
          .first<{ id: string }>();
        if (tag) {
          await db
            .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
            .bind(friendId, tag.id, jstNow())
            .run();
        }
      }

      // イベントバスに発火（自動化ルール用）
      const { fireEvent } = await import('../services/event-bus.js');
      await fireEvent(db, 'cv_fire', { friendId, eventData: { type: 'purchase', amount: obj.amount, stripeEventId: body.id } });
    }

    // サブスクリプションイベント処理
    if (body.type === 'customer.subscription.deleted' && friendId) {
      const cancelledTag = await db
        .prepare(`SELECT id FROM tags WHERE name = 'subscription_cancelled'`)
        .first<{ id: string }>();
      if (cancelledTag) {
        await db
          .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
          .bind(friendId, cancelledTag.id, jstNow())
          .run();
      }
    }

    return c.json({
      success: true,
      data: { id: event.id, stripeEventId: event.stripe_event_id, eventType: event.event_type, processedAt: event.processed_at },
    });
  } catch (err) {
    console.error('POST /api/integrations/stripe/webhook error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { stripe };
