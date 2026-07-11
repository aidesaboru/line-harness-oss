-- Add the formal "secondary_answered" case status.
-- D1/SQLite cannot relax an existing CHECK constraint in place, so rebuild
-- support_cases with the same columns and indexes, then copy existing rows.

PRAGMA foreign_keys=off;

DROP TABLE IF EXISTS support_cases_new;

CREATE TABLE support_cases_new (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  friend_id             TEXT REFERENCES friends(id) ON DELETE SET NULL,
  title                 TEXT NOT NULL,
  category              TEXT NOT NULL DEFAULT 'other',
  priority              TEXT NOT NULL DEFAULT 'medium'
                         CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status                TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN (
                           'open',
                           'in_progress',
                           'waiting_primary',
                           'escalated',
                           'waiting_secondary',
                           'secondary_answered',
                           'customer_reply',
                           'on_hold',
                           'resolved',
                           'reopened'
                         )),
  primary_assignee      TEXT,
  escalation_assignee   TEXT,
  escalation_level      TEXT NOT NULL DEFAULT 'L1'
                         CHECK (escalation_level IN ('L1', 'L2', 'L3')),
  due_at                TEXT,
  next_check_at         TEXT,
  customer_number       TEXT,
  company_name          TEXT,
  contact_name          TEXT,
  store_name            TEXT,
  contract_type         TEXT,
  customer_summary      TEXT NOT NULL DEFAULT '',
  internal_note         TEXT NOT NULL DEFAULT '',
  customer_reply_draft  TEXT NOT NULL DEFAULT '',
  resolution_note       TEXT NOT NULL DEFAULT '',
  manual_ids            TEXT NOT NULL DEFAULT '[]',
  created_by            TEXT,
  updated_by            TEXT,
  closed_at             TEXT,
  reopened_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

INSERT INTO support_cases_new (
  id, line_account_id, friend_id, title, category, priority, status,
  primary_assignee, escalation_assignee, escalation_level, due_at, next_check_at,
  customer_number, company_name, contact_name, store_name, contract_type,
  customer_summary, internal_note, customer_reply_draft, resolution_note, manual_ids,
  created_by, updated_by, closed_at, reopened_at, created_at, updated_at
)
SELECT
  id, line_account_id, friend_id, title, category, priority, status,
  primary_assignee, escalation_assignee, escalation_level, due_at, next_check_at,
  customer_number, company_name, contact_name, store_name, contract_type,
  customer_summary, internal_note, customer_reply_draft, resolution_note, manual_ids,
  created_by, updated_by, closed_at, reopened_at, created_at, updated_at
FROM support_cases;

DROP TABLE support_cases;

ALTER TABLE support_cases_new RENAME TO support_cases;

CREATE INDEX IF NOT EXISTS idx_support_cases_account_status
  ON support_cases(line_account_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_support_cases_friend
  ON support_cases(friend_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_support_cases_due
  ON support_cases(due_at, status);

CREATE INDEX IF NOT EXISTS idx_support_cases_account_due_status
  ON support_cases(line_account_id, due_at, status);

CREATE INDEX IF NOT EXISTS idx_support_cases_assignee
  ON support_cases(primary_assignee, escalation_assignee, status);

PRAGMA foreign_keys=on;
