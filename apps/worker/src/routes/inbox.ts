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

type InboxQueryReader = {
  query: (key: string) => string | undefined;
};

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function buildUnansweredOptions(
  req: InboxQueryReader,
  staff: SupportAccessStaff,
  includePaging: boolean,
): UnansweredInboxOptions {
  const q = req.query('q')?.trim();
  const opts: UnansweredInboxOptions = {
    q: q || undefined,
    account: req.query('account') || undefined,
    minWaitMinutes: parseOptionalPositiveInteger(req.query('minWaitMinutes')),
    staff,
  };
  if (includePaging) {
    opts.page = parseOptionalPositiveInteger(req.query('page'));
    opts.pageSize = parseOptionalPositiveInteger(req.query('pageSize'));
  }
  return opts;
}

inbox.get('/api/inbox/unanswered', async (c) => {
  try {
    const result = await computeUnansweredInbox(
      c.env.DB,
      buildUnansweredOptions(c.req, currentSupportStaff(c), true),
    );
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /api/inbox/unanswered error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

inbox.get('/api/inbox/unanswered/count', async (c) => {
  try {
    const result = await countUnanswered(
      c.env.DB,
      buildUnansweredOptions(c.req, currentSupportStaff(c), false),
    );
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('GET /api/inbox/unanswered/count error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
