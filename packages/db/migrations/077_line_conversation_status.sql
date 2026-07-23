-- Existing conversations become unread without rewriting any preserved rows.
-- Application inserts explicitly set new conversations to resolved.
ALTER TABLE line_conversations
ADD COLUMN status TEXT NOT NULL DEFAULT 'unread'
CHECK (status IN ('unread', 'resolved'));

CREATE INDEX IF NOT EXISTS idx_line_conversations_account_status_last_message
ON line_conversations (line_account_id, status, last_message_at);
