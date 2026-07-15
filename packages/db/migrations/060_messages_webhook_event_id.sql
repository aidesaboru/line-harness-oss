ALTER TABLE messages_log ADD COLUMN webhook_event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_log_webhook_event_id
ON messages_log (webhook_event_id)
WHERE webhook_event_id IS NOT NULL;
