-- Append-only audit history for group/room customer identity changes.
-- The current JSON remains on line_conversations for fast reads, while every
-- change keeps both previous and next values for recovery and investigation.
CREATE TABLE IF NOT EXISTS line_conversation_customer_events (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES line_conversations(id) ON DELETE RESTRICT,
  line_account_id   TEXT,
  event_type        TEXT NOT NULL CHECK (event_type = 'customer_profile_updated'),
  actor_id           TEXT,
  actor_name         TEXT,
  before_profile     TEXT NOT NULL CHECK (json_valid(before_profile)),
  after_profile      TEXT NOT NULL CHECK (json_valid(after_profile)),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_line_conversation_customer_events_conversation
ON line_conversation_customer_events(conversation_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_line_conversation_customer_events_no_update
BEFORE UPDATE ON line_conversation_customer_events
BEGIN
  SELECT RAISE(ABORT, 'line conversation customer events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_line_conversation_customer_events_no_delete
BEFORE DELETE ON line_conversation_customer_events
BEGIN
  SELECT RAISE(ABORT, 'line conversation customer events are append-only');
END;
