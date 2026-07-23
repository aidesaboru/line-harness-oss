-- Keep the legacy status column for compatibility and add the richer workflow state beside it.
ALTER TABLE line_conversations
ADD COLUMN workflow_status TEXT
CHECK (workflow_status IN ('unread', 'in_progress', 'long_term', 'resolved'));

CREATE INDEX IF NOT EXISTS idx_line_conversations_account_workflow_last_message
ON line_conversations (line_account_id, workflow_status, last_message_at);

ALTER TABLE line_conversation_messages
ADD COLUMN mark_as_read_token TEXT;

ALTER TABLE line_conversation_messages
ADD COLUMN marked_as_read_at TEXT;

ALTER TABLE line_conversation_messages
ADD COLUMN marked_as_read_by TEXT;

ALTER TABLE line_conversation_messages
ADD COLUMN quoted_message_id TEXT;

ALTER TABLE line_conversation_messages
ADD COLUMN sent_by_staff_id TEXT;

ALTER TABLE line_conversation_messages
ADD COLUMN sent_by_staff_name TEXT;

CREATE INDEX IF NOT EXISTS idx_line_conversation_messages_quoted_message
ON line_conversation_messages (quoted_message_id);
