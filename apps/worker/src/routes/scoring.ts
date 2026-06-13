import { Hono, type Context } from 'hono';
import {
  getScoringRules,
  getScoringRuleById,
  createScoringRule,
  updateScoringRule,
  deleteScoringRule,
  getFriendScore,
  getFriendScoreHistory,
  addScore,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { ensureSupportFriendAccess } from './support-friend-access.js';
import { requireRole } from '../middleware/role-guard.js';

const scoring = new Hono<Env>();

const SCORING_VISIBLE_ID_MAX_LENGTH = 128;
const SCORING_TEXT_MAX_LENGTH = 128;
const SCORING_REASON_MAX_LENGTH = 1000;
const SCORING_SCORE_VALUE_MAX = 1_000_000;
const SCORING_VISIBLE_ASCII_PATTERN = /^[!-~]+$/;

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };
type ScoringRuleInput = {
  name: string;
  eventType: string;
  scoreValue: number;
};
type ScoringRuleUpdateInput = {
  name?: string;
  eventType?: string;
  scoreValue?: number;
  isActive?: boolean;
};
type FriendScoreInput = {
  scoreChange: number;
  reason?: string;
};

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

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

function parseVisibleString(raw: unknown, label: string): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value || value.length > SCORING_VISIBLE_ID_MAX_LENGTH || !SCORING_VISIBLE_ASCII_PATTERN.test(value)) {
    return { ok: false, error: `invalid_${label}` };
  }
  return { ok: true, value };
}

function parseRequiredText(raw: unknown, error: string, maxLength = SCORING_TEXT_MAX_LENGTH): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error };
  const value = raw.trim();
  if (!value || value.length > maxLength) return { ok: false, error };
  return { ok: true, value };
}

function parseOptionalText(raw: unknown, error: string, maxLength: number): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > maxLength) return { ok: false, error };
  return { ok: true, value };
}

function parseInteger(raw: unknown, error: string, min: number, max: number): ValueResult<number> {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false, error };
  if (raw < min || raw > max) return { ok: false, error };
  return { ok: true, value: raw };
}

function parseOptionalFlag(raw: unknown, error: string): ValueResult<boolean | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw === 'boolean') return { ok: true, value: raw };
  if (raw === 0 || raw === 1) return { ok: true, value: raw === 1 };
  return { ok: false, error };
}

function parseScoringRuleInput(body: Record<string, unknown>): ValueResult<ScoringRuleInput> {
  const name = parseRequiredText(body.name, 'invalid_name');
  if (!name.ok) return name;
  const eventType = parseVisibleString(body.eventType, 'event_type');
  if (!eventType.ok) return eventType;
  const scoreValue = parseInteger(body.scoreValue, 'invalid_score_value', -SCORING_SCORE_VALUE_MAX, SCORING_SCORE_VALUE_MAX);
  if (!scoreValue.ok) return scoreValue;
  return { ok: true, value: { name: name.value, eventType: eventType.value, scoreValue: scoreValue.value } };
}

function parseScoringRuleUpdateInput(body: Record<string, unknown>): ValueResult<ScoringRuleUpdateInput> {
  const input: ScoringRuleUpdateInput = {};
  if (hasOwn(body, 'name')) {
    const name = parseRequiredText(body.name, 'invalid_name');
    if (!name.ok) return name;
    input.name = name.value;
  }
  if (hasOwn(body, 'eventType')) {
    const eventType = parseVisibleString(body.eventType, 'event_type');
    if (!eventType.ok) return eventType;
    input.eventType = eventType.value;
  }
  if (hasOwn(body, 'scoreValue')) {
    const scoreValue = parseInteger(body.scoreValue, 'invalid_score_value', -SCORING_SCORE_VALUE_MAX, SCORING_SCORE_VALUE_MAX);
    if (!scoreValue.ok) return scoreValue;
    input.scoreValue = scoreValue.value;
  }
  if (hasOwn(body, 'isActive')) {
    const isActive = parseOptionalFlag(body.isActive, 'invalid_is_active');
    if (!isActive.ok || isActive.value === undefined) return { ok: false, error: 'invalid_is_active' };
    input.isActive = isActive.value;
  }
  if (Object.keys(input).length === 0) return { ok: false, error: 'invalid_payload' };
  return { ok: true, value: input };
}

function parseFriendScoreInput(body: Record<string, unknown>): ValueResult<FriendScoreInput> {
  const scoreChange = parseInteger(body.scoreChange, 'invalid_score_change', -SCORING_SCORE_VALUE_MAX, SCORING_SCORE_VALUE_MAX);
  if (!scoreChange.ok) return scoreChange;
  const reason = parseOptionalText(body.reason, 'invalid_reason', SCORING_REASON_MAX_LENGTH);
  if (!reason.ok) return reason;
  return {
    ok: true,
    value: {
      scoreChange: scoreChange.value,
      ...(reason.value !== undefined ? { reason: reason.value } : {}),
    },
  };
}

// ========== スコアリングルールCRUD ==========

scoring.get('/api/scoring-rules', requireRole('owner', 'admin'), async (c) => {
  try {
    const items = await getScoringRules(c.env.DB);
    return c.json({
      success: true,
      data: items.map((r) => ({
        id: r.id,
        name: r.name,
        eventType: r.event_type,
        scoreValue: r.score_value,
        isActive: Boolean(r.is_active),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/scoring-rules error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

scoring.get('/api/scoring-rules/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'scoring_rule_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const item = await getScoringRuleById(c.env.DB, id.value);
    if (!item) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({
      success: true,
      data: { id: item.id, name: item.name, eventType: item.event_type, scoreValue: item.score_value, isActive: Boolean(item.is_active), createdAt: item.created_at },
    });
  } catch (err) {
    console.error('GET /api/scoring-rules/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

scoring.post('/api/scoring-rules', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseScoringRuleInput(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    const item = await createScoringRule(c.env.DB, body.value);
    return c.json({ success: true, data: { id: item.id, name: item.name, eventType: item.event_type, scoreValue: item.score_value } }, 201);
  } catch (err) {
    console.error('POST /api/scoring-rules error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

scoring.put('/api/scoring-rules/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'scoring_rule_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseScoringRuleUpdateInput(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    await updateScoringRule(c.env.DB, id.value, body.value);
    const updated = await getScoringRuleById(c.env.DB, id.value);
    if (!updated) return c.json({ success: false, error: 'Not found' }, 404);
    return c.json({ success: true, data: { id: updated.id, name: updated.name, eventType: updated.event_type, scoreValue: updated.score_value, isActive: Boolean(updated.is_active) } });
  } catch (err) {
    console.error('PUT /api/scoring-rules/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

scoring.delete('/api/scoring-rules/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseVisibleString(c.req.param('id'), 'scoring_rule_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteScoringRule(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/scoring-rules/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 友だちスコア ==========

scoring.get('/api/friends/:id/score', async (c) => {
  try {
    const friendId = parseVisibleString(c.req.param('id'), 'friend_id');
    if (!friendId.ok) return c.json({ success: false, error: friendId.error }, 400);
    const denied = await ensureSupportFriendAccess(c, friendId.value);
    if (denied) return denied;
    const [score, history] = await Promise.all([
      getFriendScore(c.env.DB, friendId.value),
      getFriendScoreHistory(c.env.DB, friendId.value),
    ]);
    return c.json({
      success: true,
      data: {
        friendId: friendId.value,
        currentScore: score,
        history: history.map((h) => ({
          id: h.id,
          scoringRuleId: h.scoring_rule_id,
          scoreChange: h.score_change,
          reason: h.reason,
          createdAt: h.created_at,
        })),
      },
    });
  } catch (err) {
    console.error('GET /api/friends/:id/score error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// 手動スコア加算
scoring.post('/api/friends/:id/score', async (c) => {
  try {
    const friendId = parseVisibleString(c.req.param('id'), 'friend_id');
    if (!friendId.ok) return c.json({ success: false, error: friendId.error }, 400);
    const denied = await ensureSupportFriendAccess(c, friendId.value);
    if (denied) return denied;
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseFriendScoreInput(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    await addScore(c.env.DB, { friendId: friendId.value, ...body.value });
    const newScore = await getFriendScore(c.env.DB, friendId.value);
    return c.json({ success: true, data: { friendId: friendId.value, currentScore: newScore } }, 201);
  } catch (err) {
    console.error('POST /api/friends/:id/score error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { scoring };
