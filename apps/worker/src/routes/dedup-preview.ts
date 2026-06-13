import { Hono, type Context } from 'hono';
import { computeDedupBroadcastPreview } from '../services/dedup-broadcast.js';
import { requireRole } from '../middleware/role-guard.js';
import type { Env } from '../index.js';

const dedupPreview = new Hono<Env>();

const DEDUP_PREVIEW_ID_MAX_LENGTH = 128;
const DEDUP_PREVIEW_MAX_ACCOUNT_IDS = 100;
const DEDUP_PREVIEW_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

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
  if (!value || value.length > DEDUP_PREVIEW_ID_MAX_LENGTH || !DEDUP_PREVIEW_VISIBLE_ASCII_PATTERN.test(value)) {
    return { ok: false, error: `invalid_${label}` };
  }
  return { ok: true, value };
}

function parseIdArray(
  raw: unknown,
  label: string,
  options: { itemLabel: string; minLength: number },
): ValueResult<string[]> {
  if (!Array.isArray(raw) || raw.length < options.minLength || raw.length > DEDUP_PREVIEW_MAX_ACCOUNT_IDS) {
    return { ok: false, error: `invalid_${label}` };
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const parsed = parseVisibleId(item, options.itemLabel);
    if (!parsed.ok) return { ok: false, error: `invalid_${label}` };
    if (!seen.has(parsed.value)) {
      seen.add(parsed.value);
      ids.push(parsed.value);
    }
  }
  return { ok: true, value: ids };
}

function parseOptionalTargetTagId(raw: unknown): ValueResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_target_tag_id' };
  if (raw.trim() === '') return { ok: true, value: null };
  const parsed = parseVisibleId(raw, 'target_tag_id');
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value };
}

dedupPreview.post(
  '/api/broadcasts/dedup-preview',
  requireRole('owner', 'admin'),
  async (c) => {
    const body = await readJsonObject(c);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);

    const accountIds = parseIdArray(
      body.value.accountIds,
      'account_ids',
      { itemLabel: 'account_id', minLength: 1 },
    );
    if (!accountIds.ok) return c.json({ success: false, error: accountIds.error }, 400);

    const dedupPriority = parseIdArray(
      body.value.dedupPriority,
      'dedup_priority',
      { itemLabel: 'dedup_priority_id', minLength: 0 },
    );
    if (!dedupPriority.ok) return c.json({ success: false, error: dedupPriority.error }, 400);

    const targetTagId = parseOptionalTargetTagId(body.value.targetTagId);
    if (!targetTagId.ok) return c.json({ success: false, error: targetTagId.error }, 400);

    const accountIdSet = new Set(accountIds.value);
    const filteredDedupPriority = dedupPriority.value.filter((id) => accountIdSet.has(id));

    const preview = await computeDedupBroadcastPreview(
      c.env.DB,
      accountIds.value,
      filteredDedupPriority,
      targetTagId.value,
    );

    // Strip recipients[] before returning — it's needed only by the send executor,
    // not the UI. Keeps the response payload small for large broadcasts.
    return c.json({
      success: true,
      data: {
        totalSelected: preview.totalSelected,
        uniqueRecipients: preview.uniqueRecipients,
        reduction: preview.reduction,
        reductionRate: preview.reductionRate,
        perAccount: preview.perAccount.map(({ recipients: _r, ...rest }) => rest),
      },
    });
  },
);

export default dedupPreview;
