-- Preserve the relationship between an operational Q&A pair and the original
-- long-running Slack thread. Segment rows are append-only audit records.

CREATE TABLE IF NOT EXISTS support_knowledge_segments (
  id                  TEXT PRIMARY KEY,
  knowledge_import_id TEXT NOT NULL REFERENCES support_knowledge_imports(id) ON DELETE RESTRICT,
  manual_id           TEXT NOT NULL UNIQUE REFERENCES support_manuals(id) ON DELETE RESTRICT,
  segment_key         TEXT NOT NULL,
  question_block_index INTEGER NOT NULL,
  answer_block_index   INTEGER NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(knowledge_import_id, segment_key)
);

CREATE INDEX IF NOT EXISTS idx_support_knowledge_segments_import
  ON support_knowledge_segments(knowledge_import_id, question_block_index, answer_block_index);

CREATE TRIGGER IF NOT EXISTS prevent_support_knowledge_segments_update
BEFORE UPDATE ON support_knowledge_segments
BEGIN
  SELECT RAISE(ABORT, 'support_knowledge_segments are append-only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_support_knowledge_segments_delete
BEFORE DELETE ON support_knowledge_segments
BEGIN
  SELECT RAISE(ABORT, 'support_knowledge_segments are append-only');
END;
