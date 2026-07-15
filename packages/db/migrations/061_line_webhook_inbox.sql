CREATE TABLE IF NOT EXISTS line_webhook_inbox (
  webhook_event_id TEXT PRIMARY KEY,
  line_account_id  TEXT,
  event_payload    TEXT NOT NULL CHECK (json_valid(event_payload)),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error_kind  TEXT,
  received_at      TEXT NOT NULL,
  processed_at     TEXT,
  next_attempt_at  TEXT,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_line_webhook_inbox_status_attempt
ON line_webhook_inbox (status, next_attempt_at, updated_at);
