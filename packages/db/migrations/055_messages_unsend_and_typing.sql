ALTER TABLE messages_log ADD COLUMN line_message_id TEXT;
ALTER TABLE messages_log ADD COLUMN deleted_at TEXT;
ALTER TABLE messages_log ADD COLUMN deleted_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_log_line_message_id ON messages_log (line_message_id);

CREATE TABLE IF NOT EXISTS chat_typing_status (
  id              TEXT PRIMARY KEY,
  chat_id         TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  friend_id       TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  staff_id        TEXT NOT NULL,
  staff_name      TEXT NOT NULL,
  line_account_id TEXT,
  expires_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (chat_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_typing_status_chat ON chat_typing_status (chat_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_chat_typing_status_friend ON chat_typing_status (friend_id, expires_at);
