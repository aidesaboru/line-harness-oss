import { Hono } from 'hono';
import type { Env } from '../index.js';
import type { SupportAccessStaff } from '../services/support-access.js';
import {
  computeUnansweredInbox,
  countUnanswered,
  type UnansweredInboxOptions,
} from '../services/unanswered-inbox.js';
import { currentSupportStaff } from './support-friend-access.js';

export const inbox = new Hono<Env>();

const INBOX_QUERY_MAX_LENGTH = 256;
const INBOX_ID_MAX_LENGTH = 128;
const INBOX_MAX_PAGE = 10_000;
const INBOX_MAX_PAGE_SIZE = 2_000;
const INBOX_MAX_MIN_WAIT_MINUTES = 525_600;
const INBOX_VISIBLE_ID_PATTERN = /^[!-~]+$/;

type InboxQueryReader = {
  query: (key: string) => string | undefined;
};

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

function inboxRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

function parseOptionalQueryText(raw: unknown, label: string): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > INBOX_QUERY_MAX_LENGTH) return { ok: false, error: `${label} is too long` };
  return { ok: true, value };
}

function parseOptionalVisibleId(raw: unknown, label: string): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > INBOX_ID_MAX_LENGTH) return { ok: false, error: `${label} is too long` };
  if (!INBOX_VISIBLE_ID_PATTERN.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  max = Number.POSITIVE_INFINITY,
): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return undefined;
  return Math.min(parsed, max);
}

function buildUnansweredOptions(
  req: InboxQueryReader,
  staff: SupportAccessStaff,
  includePaging: boolean,
): ValueResult<UnansweredInboxOptions> {
  const q = parseOptionalQueryText(req.query('q'), 'q');
  if (!q.ok) return q;
  const account = parseOptionalVisibleId(req.query('account'), 'account');
  if (!account.ok) return account;
  const opts: UnansweredInboxOptions = {
    q: q.value,
    account: account.value,
    minWaitMinutes: parseOptionalPositiveInteger(req.query('minWaitMinutes'), INBOX_MAX_MIN_WAIT_MINUTES),
    staff,
  };
  if (includePaging) {
    opts.page = parseOptionalPositiveInteger(req.query('page'), INBOX_MAX_PAGE);
    opts.pageSize = parseOptionalPositiveInteger(req.query('pageSize'), INBOX_MAX_PAGE_SIZE);
  }
  return { ok: true, value: opts };
}

inbox.get('/api/inbox/unanswered', async (c) => {
  try {
    const opts = buildUnansweredOptions(c.req, currentSupportStaff(c), true);
    if (!opts.ok) return c.json({ success: false, error: opts.error }, 400);
    const result = await computeUnansweredInbox(c.env.DB, opts.value);
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error(`GET /api/inbox/unanswered error: ${inboxRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

inbox.get('/api/inbox/unanswered/count', async (c) => {
  try {
    const opts = buildUnansweredOptions(c.req, currentSupportStaff(c), false);
    if (!opts.ok) return c.json({ success: false, error: opts.error }, 400);
    const result = await countUnanswered(c.env.DB, opts.value);
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error(`GET /api/inbox/unanswered/count error: ${inboxRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
