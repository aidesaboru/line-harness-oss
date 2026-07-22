CREATE TABLE IF NOT EXISTS line_conversations (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT,
  source_type     TEXT NOT NULL CHECK (source_type IN ('group', 'room')),
  source_id       TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  picture_url     TEXT,
  last_message_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_line_conversations_source
ON line_conversations (COALESCE(line_account_id, ''), source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_line_conversations_account_last_message
ON line_conversations (line_account_id, last_message_at);

CREATE TABLE IF NOT EXISTS line_conversation_messages (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES line_conversations (id) ON DELETE CASCADE,
  direction          TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  message_type       TEXT NOT NULL,
  content            TEXT NOT NULL,
  source             TEXT NOT NULL,
  line_account_id    TEXT,
  line_message_id    TEXT,
  webhook_event_id   TEXT,
  quote_token        TEXT,
  sender_user_id     TEXT,
  sender_name        TEXT,
  sender_picture_url TEXT,
  deleted_at         TEXT,
  deleted_reason     TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_line_conversation_messages_conversation_created
ON line_conversation_messages (conversation_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_line_conversation_messages_line_message
ON line_conversation_messages (line_message_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_line_conversation_messages_webhook_event
ON line_conversation_messages (webhook_event_id)
WHERE webhook_event_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS protect_line_conversations_delete
BEFORE DELETE ON line_conversations
BEGIN
  SELECT RAISE(ABORT, 'line conversations history is protected');
END;

CREATE TRIGGER IF NOT EXISTS protect_line_conversation_messages_delete
BEFORE DELETE ON line_conversation_messages
BEGIN
  SELECT RAISE(ABORT, 'line conversation messages history is protected');
END;
