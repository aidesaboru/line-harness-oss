-- Operational knowledge fields are additive. The original manual body and Slack import
-- records remain untouched and continue to be the audit source of truth.

ALTER TABLE support_manuals ADD COLUMN knowledge_question TEXT NOT NULL DEFAULT '';
ALTER TABLE support_manuals ADD COLUMN knowledge_resolution TEXT NOT NULL DEFAULT '';
ALTER TABLE support_manuals ADD COLUMN knowledge_procedure TEXT NOT NULL DEFAULT '';
ALTER TABLE support_manuals ADD COLUMN knowledge_applicability TEXT NOT NULL DEFAULT '';
ALTER TABLE support_manuals ADD COLUMN knowledge_cautions TEXT NOT NULL DEFAULT '';
ALTER TABLE support_manuals ADD COLUMN knowledge_source_body TEXT NOT NULL DEFAULT '';
ALTER TABLE support_manuals ADD COLUMN knowledge_status TEXT NOT NULL DEFAULT 'needs_review';
ALTER TABLE support_manuals ADD COLUMN knowledge_quality_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE support_manuals ADD COLUMN knowledge_review_note TEXT NOT NULL DEFAULT '';
ALTER TABLE support_manuals ADD COLUMN knowledge_use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE support_manuals ADD COLUMN knowledge_last_used_at TEXT;
ALTER TABLE support_manuals ADD COLUMN knowledge_helpful_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE support_manuals ADD COLUMN knowledge_needs_improvement_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_support_manuals_account_knowledge_status
  ON support_manuals(line_account_id, knowledge_status, is_active, revised_at);

CREATE TABLE IF NOT EXISTS support_knowledge_source_snapshots (
  id                  TEXT PRIMARY KEY,
  knowledge_import_id TEXT NOT NULL REFERENCES support_knowledge_imports(id) ON DELETE RESTRICT,
  line_account_id     TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  source_channel_id   TEXT NOT NULL,
  source_thread_ts    TEXT NOT NULL,
  raw_payload         TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  is_reconstructed    INTEGER NOT NULL DEFAULT 0,
  captured_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(knowledge_import_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_support_knowledge_source_snapshots_import
  ON support_knowledge_source_snapshots(knowledge_import_id, captured_at);

CREATE TABLE IF NOT EXISTS support_manual_revisions (
  id              TEXT PRIMARY KEY,
  manual_id       TEXT NOT NULL REFERENCES support_manuals(id) ON DELETE RESTRICT,
  line_account_id TEXT,
  change_type     TEXT NOT NULL,
  snapshot        TEXT NOT NULL,
  actor_id        TEXT,
  actor_name      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_support_manual_revisions_manual_created
  ON support_manual_revisions(manual_id, created_at);

CREATE TABLE IF NOT EXISTS support_manual_usage_events (
  id              TEXT PRIMARY KEY,
  manual_id       TEXT NOT NULL REFERENCES support_manuals(id) ON DELETE RESTRICT,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  action          TEXT NOT NULL CHECK (action IN ('copied', 'helpful', 'needs_improvement')),
  actor_id        TEXT,
  actor_name      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_support_manual_usage_events_manual_created
  ON support_manual_usage_events(manual_id, created_at);

CREATE TRIGGER IF NOT EXISTS prevent_support_manuals_delete
BEFORE DELETE ON support_manuals
BEGIN
  SELECT RAISE(ABORT, 'support_manuals cannot be deleted; set is_active = 0 instead');
END;

CREATE TRIGGER IF NOT EXISTS prevent_support_knowledge_imports_delete
BEFORE DELETE ON support_knowledge_imports
BEGIN
  SELECT RAISE(ABORT, 'support_knowledge_imports cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS prevent_support_knowledge_source_snapshots_update
BEFORE UPDATE ON support_knowledge_source_snapshots
BEGIN
  SELECT RAISE(ABORT, 'support_knowledge_source_snapshots are append-only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_support_knowledge_source_snapshots_delete
BEFORE DELETE ON support_knowledge_source_snapshots
BEGIN
  SELECT RAISE(ABORT, 'support_knowledge_source_snapshots are append-only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_support_manual_revisions_update
BEFORE UPDATE ON support_manual_revisions
BEGIN
  SELECT RAISE(ABORT, 'support_manual_revisions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_support_manual_revisions_delete
BEFORE DELETE ON support_manual_revisions
BEGIN
  SELECT RAISE(ABORT, 'support_manual_revisions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_support_manual_usage_events_update
BEFORE UPDATE ON support_manual_usage_events
BEGIN
  SELECT RAISE(ABORT, 'support_manual_usage_events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_support_manual_usage_events_delete
BEFORE DELETE ON support_manual_usage_events
BEGIN
  SELECT RAISE(ABORT, 'support_manual_usage_events are append-only');
END;
