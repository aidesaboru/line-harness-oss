import { Hono } from 'hono';
import type { Env } from '../index.js';
import { computeUsersGrouped, type UsersGroupedOptions } from '../services/users-grouped.js';
import { currentSupportStaff } from './support-friend-access.js';

export const usersGrouped = new Hono<Env>();

const USERS_GROUPED_QUERY_MAX_LENGTH = 256;
const USERS_GROUPED_ID_MAX_LENGTH = 128;
const USERS_GROUPED_MAX_PAGE = 10_000;
const USERS_GROUPED_MAX_PAGE_SIZE = 200;
const USERS_GROUPED_VISIBLE_ID_PATTERN = /^[!-~]+$/;

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseOptionalQueryText(raw: unknown, label: string): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > USERS_GROUPED_QUERY_MAX_LENGTH) return { ok: false, error: `${label} is too long` };
  return { ok: true, value };
}

function parseOptionalVisibleId(raw: unknown, label: string): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > USERS_GROUPED_ID_MAX_LENGTH) return { ok: false, error: `${label} is too long` };
  if (!USERS_GROUPED_VISIBLE_ID_PATTERN.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseOptionalFlag(raw: unknown, label: string): ValueResult<boolean> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: false };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: false };
  if (value === '1') return { ok: true, value: true };
  if (value === '0') return { ok: true, value: false };
  return { ok: false, error: `${label} is invalid` };
}

function parseOptionalPositiveInteger(
  raw: unknown,
  label: string,
  max: number,
): ValueResult<number | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (!/^\d+$/.test(value)) return { ok: false, error: `${label} is invalid` };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value: Math.min(parsed, max) };
}

usersGrouped.get('/api/users-grouped', async (c) => {
  try {
    const q = parseOptionalQueryText(c.req.query('q'), 'q');
    if (!q.ok) return c.json({ success: false, error: q.error }, 400);
    const onlyDups = parseOptionalFlag(c.req.query('onlyDups'), 'onlyDups');
    if (!onlyDups.ok) return c.json({ success: false, error: onlyDups.error }, 400);
    const account = parseOptionalVisibleId(c.req.query('account'), 'account');
    if (!account.ok) return c.json({ success: false, error: account.error }, 400);
    const page = parseOptionalPositiveInteger(c.req.query('page'), 'page', USERS_GROUPED_MAX_PAGE);
    if (!page.ok) return c.json({ success: false, error: page.error }, 400);
    const pageSize = parseOptionalPositiveInteger(c.req.query('pageSize'), 'pageSize', USERS_GROUPED_MAX_PAGE_SIZE);
    if (!pageSize.ok) return c.json({ success: false, error: pageSize.error }, 400);
    const forceRefresh = parseOptionalFlag(c.req.query('refresh'), 'refresh');
    if (!forceRefresh.ok) return c.json({ success: false, error: forceRefresh.error }, 400);

    const opts: UsersGroupedOptions = {
      q: q.value,
      onlyDups: onlyDups.value,
      account: account.value,
      page: page.value,
      pageSize: pageSize.value,
      forceRefresh: forceRefresh.value,
      staff: currentSupportStaff(c),
    };

    const result = await computeUsersGrouped(c.env.DB, opts);
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /api/users-grouped error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
