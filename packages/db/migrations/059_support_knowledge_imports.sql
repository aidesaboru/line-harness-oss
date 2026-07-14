-- Slack secondary-response knowledge imports.
-- Imported items are reviewed before they become active support manuals.

CREATE TABLE IF NOT EXISTS support_knowledge_imports (
  id                  TEXT PRIMARY KEY,
  line_account_id     TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  source              TEXT NOT NULL DEFAULT 'slack' CHECK (source IN ('slack')),
  source_channel_id   TEXT NOT NULL,
  source_channel_name TEXT,
  source_message_ts   TEXT NOT NULL,
  source_thread_ts    TEXT NOT NULL,
  source_permalink    TEXT,
  source_author       TEXT,
  source_posted_at    TEXT,
  title               TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'other',
  question            TEXT NOT NULL DEFAULT '',
  answer              TEXT NOT NULL DEFAULT '',
  body                TEXT NOT NULL DEFAULT '',
  keywords            TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'dismissed')),
  manual_id           TEXT REFERENCES support_manuals(id) ON DELETE SET NULL,
  imported_by         TEXT,
  reviewed_by         TEXT,
  imported_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  reviewed_at         TEXT,
  published_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(source_channel_id, source_thread_ts)
);

CREATE INDEX IF NOT EXISTS idx_support_knowledge_imports_account_status
  ON support_knowledge_imports(line_account_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_support_knowledge_imports_source
  ON support_knowledge_imports(source_channel_id, source_thread_ts);
