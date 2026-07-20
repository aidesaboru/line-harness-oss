ALTER TABLE chats ADD COLUMN is_long_term INTEGER NOT NULL DEFAULT 0 CHECK (is_long_term IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_chats_long_term
  ON chats (is_long_term, last_message_at);

CREATE TABLE IF NOT EXISTS scheduled_chat_messages (
  id                  TEXT PRIMARY KEY,
  chat_id             TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  friend_id           TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  line_account_id     TEXT,
  messages_json       TEXT NOT NULL,
  support_case_id     TEXT,
  scheduled_at        TEXT NOT NULL,
  next_attempt_at     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'failed_permanent', 'cancelled')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_by          TEXT,
  created_by_name     TEXT,
  sent_at             TEXT,
  cancelled_at        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_chat_messages_due
  ON scheduled_chat_messages (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_chat_messages_chat
  ON scheduled_chat_messages (chat_id, scheduled_at DESC);
