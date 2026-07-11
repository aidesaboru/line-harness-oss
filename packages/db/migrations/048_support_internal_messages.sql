-- Internal staff chat for support cases. Customer-facing LINE messages stay in messages_log.

CREATE TABLE IF NOT EXISTS support_internal_messages (
  id               TEXT PRIMARY KEY,
  case_id          TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  line_account_id  TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  parent_id        TEXT REFERENCES support_internal_messages(id) ON DELETE CASCADE,
  body             TEXT NOT NULL,
  mentions         TEXT NOT NULL DEFAULT '[]',
  created_by       TEXT,
  created_by_name  TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_support_internal_messages_case
  ON support_internal_messages(case_id, created_at);

CREATE INDEX IF NOT EXISTS idx_support_internal_messages_parent
  ON support_internal_messages(parent_id, created_at);

CREATE INDEX IF NOT EXISTS idx_support_internal_messages_account
  ON support_internal_messages(line_account_id, created_at);
