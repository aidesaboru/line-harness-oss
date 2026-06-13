import { Hono, type Context } from 'hono';
import {
  getAutoReplies,
  getAutoReplyById,
  createAutoReply,
  updateAutoReply,
  deleteAutoReply,
} from '@line-crm/db';
import type { AutoReply as DbAutoReply } from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const autoReplies = new Hono<Env>();

const AUTO_REPLY_ID_MAX_LENGTH = 128;
const AUTO_REPLY_KEYWORD_MAX_LENGTH = 200;
const AUTO_REPLY_CONTENT_MAX_LENGTH = 10000;
const AUTO_REPLY_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;
const AUTO_REPLY_MATCH_TYPES = new Set(['exact', 'contains']);
const AUTO_REPLY_RESPONSE_TYPES = new Set(['text', 'flex', 'image', 'silent']);

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };
type AutoReplyMatchType = 'exact' | 'contains';

async function readJsonObject(c: Context<Env>): Promise<ValueResult<Record<string, unknown>>> {
  try {
    const body = await c.req.json<unknown>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, error: 'invalid_payload' };
    }
    return { ok: true, value: body as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

function parseVisibleId(raw: unknown, label: string): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value || value.length > AUTO_REPLY_ID_MAX_LENGTH || !AUTO_REPLY_VISIBLE_ASCII_PATTERN.test(value)) {
    return { ok: false, error: `invalid_${label}` };
  }
  return { ok: true, value };
}

function parseOptionalVisibleId(raw: unknown, label: string): ValueResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  if (raw.trim() === '') return { ok: true, value: null };
  return parseVisibleId(raw, label);
}

function parseKeyword(raw: unknown): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_keyword' };
  const value = raw.trim();
  if (!value || value.length > AUTO_REPLY_KEYWORD_MAX_LENGTH) {
    return { ok: false, error: 'invalid_keyword' };
  }
  return { ok: true, value };
}

function parseOptionalMatchType(raw: unknown): ValueResult<AutoReplyMatchType | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || !AUTO_REPLY_MATCH_TYPES.has(raw)) {
    return { ok: false, error: 'invalid_match_type' };
  }
  return { ok: true, value: raw as AutoReplyMatchType };
}

function parseOptionalResponseType(raw: unknown): ValueResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || !AUTO_REPLY_RESPONSE_TYPES.has(raw)) {
    return { ok: false, error: 'invalid_response_type' };
  }
  return { ok: true, value: raw };
}

function parseOptionalContent(raw: unknown): ValueResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || raw.length > AUTO_REPLY_CONTENT_MAX_LENGTH) {
    return { ok: false, error: 'invalid_response_content' };
  }
  return { ok: true, value: raw.trim() };
}

function parseOptionalBoolean(raw: unknown, label: string): ValueResult<boolean | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'boolean') return { ok: false, error: `invalid_${label}` };
  return { ok: true, value: raw };
}

type ParsedAutoReplyCreate = {
  keyword: string;
  matchType: AutoReplyMatchType | undefined;
  responseType: string;
  responseContent: string;
  templateId: string | null;
  lineAccountId: string | null;
};

function parseAutoReplyCreate(body: Record<string, unknown>): ValueResult<ParsedAutoReplyCreate> {
  const keyword = parseKeyword(body.keyword);
  if (!keyword.ok) return keyword;
  const matchType = parseOptionalMatchType(body.matchType);
  if (!matchType.ok) return matchType;
  const responseType = parseOptionalResponseType(body.responseType);
  if (!responseType.ok) return responseType;
  const responseContent = parseOptionalContent(body.responseContent);
  if (!responseContent.ok) return responseContent;
  const templateId = parseOptionalVisibleId(body.templateId, 'template_id');
  if (!templateId.ok) return templateId;
  const lineAccountId = parseOptionalVisibleId(body.lineAccountId, 'line_account_id');
  if (!lineAccountId.ok) return lineAccountId;

  const finalResponseType = responseType.value ?? 'text';
  const finalResponseContent = responseContent.value ?? '';
  if (!templateId.value && finalResponseType !== 'silent' && !finalResponseContent) {
    return { ok: false, error: 'invalid_response_content' };
  }

  return {
    ok: true,
    value: {
      keyword: keyword.value,
      matchType: matchType.value,
      responseType: finalResponseType,
      responseContent: finalResponseContent,
      templateId: templateId.value,
      lineAccountId: lineAccountId.value,
    },
  };
}

function parseAutoReplyUpdate(body: Record<string, unknown>): ValueResult<Record<string, unknown>> {
  const input: Record<string, unknown> = {};

  if ('keyword' in body) {
    const keyword = parseKeyword(body.keyword);
    if (!keyword.ok) return keyword;
    input.keyword = keyword.value;
  }
  if ('matchType' in body) {
    const matchType = parseOptionalMatchType(body.matchType);
    if (!matchType.ok) return matchType;
    input.matchType = matchType.value;
  }
  if ('responseType' in body) {
    const responseType = parseOptionalResponseType(body.responseType);
    if (!responseType.ok) return responseType;
    input.responseType = responseType.value;
  }
  if ('responseContent' in body) {
    const responseContent = parseOptionalContent(body.responseContent);
    if (!responseContent.ok) return responseContent;
    input.responseContent = responseContent.value;
  }
  if ('templateId' in body) {
    const templateId = parseOptionalVisibleId(body.templateId, 'template_id');
    if (!templateId.ok) return templateId;
    input.templateId = templateId.value;
  }
  if ('lineAccountId' in body) {
    const lineAccountId = parseOptionalVisibleId(body.lineAccountId, 'line_account_id');
    if (!lineAccountId.ok) return lineAccountId;
    input.lineAccountId = lineAccountId.value;
  }
  if ('isActive' in body) {
    const isActive = parseOptionalBoolean(body.isActive, 'is_active');
    if (!isActive.ok) return isActive;
    input.isActive = isActive.value;
  }

  if (Object.keys(input).length === 0) return { ok: false, error: 'empty_update' };
  if (
    'responseContent' in input &&
    input.responseType !== 'silent' &&
    !input.templateId &&
    input.responseContent === ''
  ) {
    return { ok: false, error: 'invalid_response_content' };
  }
  return { ok: true, value: input };
}

interface EffectiveAccount {
  accountId: string;
  accountName: string;
  status: 'reply' | 'silent' | 'not_applicable';
  via: 'inline' | 'automation' | null;
}

interface SerializedAutoReply {
  id: string;
  keyword: string;
  matchType: 'exact' | 'contains';
  responseType: string;
  responseContent: string;
  templateId: string | null;
  lineAccountId: string | null;
  isActive: boolean;
  createdAt: string;
  effectiveAccounts?: EffectiveAccount[];
}

function serializeAutoReply(row: DbAutoReply): SerializedAutoReply {
  return {
    id: row.id,
    keyword: row.keyword,
    matchType: row.match_type,
    responseType: row.response_type,
    responseContent: row.response_content,
    templateId: row.template_id,
    lineAccountId: row.line_account_id,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  };
}

/**
 * 全 active LINE accounts と全 active automations を一発で取って、各 auto_reply の
 * 「実際にどのアカで返信するか」を計算する。auto_reply の line_account_id が null
 * なら全アカ対象、specific なら対象 1 アカのみ。返信は inline (silent 以外) または
 * 同 keyword の automation rule (event_type='message_received') で起きる。
 */
async function computeEffectiveAccounts(
  db: D1Database,
  rule: DbAutoReply,
  accounts: Array<{ id: string; name: string }>,
  automationsByKeyword: Map<string, Set<string>>,  // keyword -> set of account_ids that have rule
): Promise<EffectiveAccount[]> {
  return accounts.map((acc) => {
    // line_account_id が specific なら対象アカ以外は適用外
    if (rule.line_account_id && rule.line_account_id !== acc.id) {
      return { accountId: acc.id, accountName: acc.name, status: 'not_applicable', via: null };
    }
    // inline 返信 (text / flex / image)
    if (rule.response_type !== 'silent') {
      return { accountId: acc.id, accountName: acc.name, status: 'reply', via: 'inline' };
    }
    // silent: 同 keyword の automation rule が同アカに存在すれば返信、無ければ silent only
    const automationAccs = automationsByKeyword.get(rule.keyword);
    if (automationAccs?.has(acc.id)) {
      return { accountId: acc.id, accountName: acc.name, status: 'reply', via: 'automation' };
    }
    return { accountId: acc.id, accountName: acc.name, status: 'silent', via: null };
  });
}

async function buildAutomationKeywordIndex(db: D1Database): Promise<Map<string, Set<string>>> {
  // event_type='message_received' で keyword を持ち、send_message を含む automation を全件取って
  // keyword -> set<account_id> のインデックス化。
  const res = await db
    .prepare(`SELECT line_account_id, conditions, actions FROM automations WHERE is_active = 1 AND event_type = 'message_received'`)
    .all<{ line_account_id: string | null; conditions: string; actions: string }>();
  const idx = new Map<string, Set<string>>();
  for (const r of res.results ?? []) {
    if (!r.line_account_id) continue;  // global rules — skip; UI assumes per-account
    let keyword: string | null = null;
    try {
      const c = JSON.parse(r.conditions) as { keyword?: string; keyword_exact?: string };
      keyword = c.keyword ?? c.keyword_exact ?? null;
    } catch { continue; }
    if (!keyword) continue;
    // send_message action があるか
    let hasSendMessage = false;
    try {
      const acts = JSON.parse(r.actions) as Array<{ type: string }>;
      hasSendMessage = acts.some((a) => a.type === 'send_message');
    } catch { continue; }
    if (!hasSendMessage) continue;
    const set = idx.get(keyword) ?? new Set<string>();
    set.add(r.line_account_id);
    idx.set(keyword, set);
  }
  return idx;
}

// GET /api/auto-replies — list all auto-replies (optional ?accountId filter)
autoReplies.get('/api/auto-replies', requireRole('owner', 'admin'), async (c) => {
  try {
    const accountId = parseOptionalVisibleId(c.req.query('accountId'), 'account_id');
    if (!accountId.ok) return c.json({ success: false, error: accountId.error }, 400);
    const items = await getAutoReplies(c.env.DB, accountId.value || undefined);

    // active LINE accounts を取得 + automations の keyword -> accounts インデックスを構築
    const accRes = await c.env.DB
      .prepare(`SELECT id, name FROM line_accounts WHERE is_active = 1 ORDER BY name`)
      .all<{ id: string; name: string }>();
    const activeAccounts = accRes.results ?? [];
    const automationIdx = await buildAutomationKeywordIndex(c.env.DB);

    const data: SerializedAutoReply[] = await Promise.all(
      items.map(async (row) => {
        const base = serializeAutoReply(row);
        base.effectiveAccounts = await computeEffectiveAccounts(c.env.DB, row, activeAccounts, automationIdx);
        return base;
      }),
    );

    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/auto-replies error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/auto-replies/:id — get by ID
autoReplies.get('/api/auto-replies/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleId(c.req.param('id'), 'auto_reply_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const item = await getAutoReplyById(c.env.DB, id.value);
    if (!item) {
      return c.json({ success: false, error: 'Auto-reply not found' }, 404);
    }
    return c.json({ success: true, data: serializeAutoReply(item) });
  } catch (err) {
    console.error('GET /api/auto-replies/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/auto-replies — create
autoReplies.post('/api/auto-replies', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const parsed = parseAutoReplyCreate(rawBody.value);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.value;

    // template_id が来てて content/type が空の場合、template の現在値を inline
    // snapshot として保存する。これがないと ON DELETE SET NULL で template_id が
    // クリアされた時に webhook resolve が空メッセージにフォールバックしてしまう。
    let resolvedResponseType = body.responseType ?? 'text';
    let resolvedResponseContent = body.responseContent ?? '';
    if (body.templateId && (!body.responseContent || !body.responseType)) {
      const { getTemplateById } = await import('@line-crm/db');
      const tpl = await getTemplateById(c.env.DB, body.templateId);
      if (tpl) {
        if (!body.responseType) resolvedResponseType = tpl.message_type;
        if (!body.responseContent) resolvedResponseContent = tpl.message_content;
      }
    }

    const item = await createAutoReply(c.env.DB, {
      keyword: body.keyword,
      matchType: body.matchType,
      responseType: resolvedResponseType,
      responseContent: resolvedResponseContent,
      templateId: body.templateId ?? null,
      lineAccountId: body.lineAccountId ?? null,
    });

    return c.json({ success: true, data: serializeAutoReply(item) }, 201);
  } catch (err) {
    console.error('POST /api/auto-replies error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/auto-replies/:id — update
autoReplies.put('/api/auto-replies/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleId(c.req.param('id'), 'auto_reply_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const parsed = parseAutoReplyUpdate(rawBody.value);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);

    const input = parsed.value;

    // templateId が新たに set されて responseContent が来てない場合は template の
    // 現在値を inline snapshot として書き込む (ON DELETE SET NULL の fallback 用)。
    if (input.templateId && !('responseContent' in input)) {
      const { getTemplateById } = await import('@line-crm/db');
      const tpl = await getTemplateById(c.env.DB, input.templateId as string);
      if (tpl) {
        input.responseContent = tpl.message_content;
        if (!('responseType' in input)) input.responseType = tpl.message_type;
      }
    }

    const updated = await updateAutoReply(c.env.DB, id.value, input as Parameters<typeof updateAutoReply>[2]);

    if (!updated) {
      return c.json({ success: false, error: 'Auto-reply not found' }, 404);
    }

    return c.json({ success: true, data: serializeAutoReply(updated) });
  } catch (err) {
    console.error('PUT /api/auto-replies/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/auto-replies/:id
autoReplies.delete('/api/auto-replies/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleId(c.req.param('id'), 'auto_reply_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const item = await getAutoReplyById(c.env.DB, id.value);
    if (!item) {
      return c.json({ success: false, error: 'Auto-reply not found' }, 404);
    }
    await deleteAutoReply(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/auto-replies/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { autoReplies };
