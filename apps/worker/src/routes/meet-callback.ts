import { Hono, type Context } from 'hono';
import type { Env } from '../index.js';
import { getFriendByLineUserId } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { assertLineSendAllowed, isLineSafetyBlockedError } from '../services/line-safety.js';

const app = new Hono<Env>();
const MIN_SECRET_LENGTH = 32;
const SIGNATURE_HEADER = 'X-Meet-Callback-Signature';

type MeetCallbackBody = {
  session_id: string;
  scenario_id: string;
  line_user_id: string;
  status: string;
  context?: Record<string, unknown>;
  transcripts: Array<{
    question_text?: string;
    transcript: string;
  }>;
  requirements_doc?: string;
  completed_at: string;
};

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

async function verifySignature(c: Context<Env>, rawBody: string): Promise<Response | null> {
  const secret = c.env.MEET_CALLBACK_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return c.json({ success: false, error: 'Meet callback signature is not configured' }, 503);
  }

  const signature = c.req.header(SIGNATURE_HEADER) ?? '';
  if (!/^[0-9a-f]{64}$/i.test(signature)) {
    return c.json({ success: false, error: `${SIGNATURE_HEADER} header is required` }, 401);
  }

  const expected = await computeHmacSha256Hex(secret, rawBody);
  if (!safeEqualHex(signature.toLowerCase(), expected)) {
    return c.json({ success: false, error: 'Invalid signature' }, 401);
  }

  return null;
}

function parseBody(rawBody: string): MeetCallbackBody | null {
  try {
    const body = JSON.parse(rawBody) as Partial<MeetCallbackBody>;
    if (
      typeof body.line_user_id !== 'string' ||
      !body.line_user_id ||
      typeof body.session_id !== 'string' ||
      typeof body.scenario_id !== 'string' ||
      typeof body.status !== 'string' ||
      typeof body.completed_at !== 'string' ||
      !Array.isArray(body.transcripts) ||
      !body.transcripts.every((item) =>
        item &&
        typeof item === 'object' &&
        typeof item.transcript === 'string' &&
        (item.question_text === undefined || typeof item.question_text === 'string'),
      ) ||
      (
        body.context !== undefined &&
        (typeof body.context !== 'object' || body.context === null || Array.isArray(body.context))
      ) ||
      (body.requirements_doc !== undefined && typeof body.requirements_doc !== 'string')
    ) {
      return null;
    }
    return body as MeetCallbackBody;
  } catch {
    return null;
  }
}

function errorKind(err: unknown): string {
  if (isLineSafetyBlockedError(err)) return 'line_safety_frozen';
  return err instanceof Error && err.name ? err.name : typeof err;
}

// Meet Harness calls this when a hearing session completes
app.post('/api/meet-callback', async (c) => {
  const rawBody = await c.req.text();
  const signatureDenied = await verifySignature(c, rawBody);
  if (signatureDenied) return signatureDenied;

  const body = parseBody(rawBody);
  if (!body) {
    return c.json({ success: false, error: 'Invalid callback body' }, 400);
  }

  const friend = await getFriendByLineUserId(c.env.DB, body.line_user_id);
  if (!friend) {
    return c.json({ success: false, error: 'friend not found' }, 404);
  }

  // Resolve LINE access token (multi-account support)
  let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  if ((friend as unknown as Record<string, unknown>).line_account_id) {
    const { getLineAccountById } = await import('@line-crm/db');
    const account = await getLineAccountById(c.env.DB, (friend as unknown as Record<string, unknown>).line_account_id as string);
    if (account) accessToken = account.channel_access_token;
  }
  const lineClient = new LineClient(accessToken);

  // Build Flex message with requirements doc
  const transcriptRows = body.transcripts.map((t) => ({
    type: 'box' as const, layout: 'vertical' as const, margin: 'md' as const,
    contents: [
      { type: 'text' as const, text: t.question_text || 'Q', size: 'xxs' as const, color: '#64748b' },
      { type: 'text' as const, text: t.transcript, size: 'sm' as const, color: '#1e293b', wrap: true },
    ],
  }));

  const resultFlex = {
    type: 'bubble', size: 'giga',
    header: {
      type: 'box', layout: 'vertical',
      contents: [
        { type: 'text', text: 'ヒアリング完了', size: 'lg', weight: 'bold', color: '#1e293b' },
        { type: 'text', text: `${friend.display_name || ''}さん`, size: 'xs', color: '#64748b', margin: 'sm' },
      ],
      paddingAll: '20px', backgroundColor: '#f0f9ff',
    },
    body: {
      type: 'box', layout: 'vertical',
      contents: [
        ...transcriptRows,
        { type: 'separator', margin: 'lg' },
        ...(body.requirements_doc ? [
          { type: 'text' as const, text: '要件定義書', size: 'sm' as const, weight: 'bold' as const, color: '#1e293b', margin: 'lg' as const },
          { type: 'text' as const, text: body.requirements_doc.slice(0, 1000), size: 'xs' as const, color: '#334155', wrap: true, margin: 'sm' as const },
        ] : []),
      ],
      paddingAll: '20px',
    },
  };

  try {
    await assertLineSendAllowed(c.env.DB, (friend as unknown as Record<string, string | null>).line_account_id);
    await lineClient.pushMessage(friend.line_user_id, [
      { type: 'flex', altText: 'ヒアリング結果', contents: resultFlex },
    ]);
  } catch (e) {
    console.error('Failed to send meet callback message:', errorKind(e));
  }

  // Save to friend metadata
  try {
    const existing = JSON.parse(friend.metadata || '{}') as Record<string, unknown>;
    const updated = {
      ...existing,
      meet_hearing: {
        session_id: body.session_id,
        status: body.status,
        context: body.context,
        transcripts: body.transcripts,
        requirements_doc: body.requirements_doc,
        completed_at: body.completed_at,
      },
    };
    await c.env.DB.prepare('UPDATE friends SET metadata = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .bind(JSON.stringify(updated), friend.id)
      .run();
  } catch (e) {
    console.error('Failed to save meet hearing to metadata:', errorKind(e));
  }

  return c.json({ success: true });
});

export { app as meetCallback };
