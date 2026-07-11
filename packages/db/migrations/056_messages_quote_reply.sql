ALTER TABLE messages_log ADD COLUMN quote_token TEXT;
ALTER TABLE messages_log ADD COLUMN quoted_message_id TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_log_quoted_message_id ON messages_log (quoted_message_id);
