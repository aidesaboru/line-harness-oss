CREATE TABLE IF NOT EXISTS inquiry_cases (
  id TEXT PRIMARY KEY,
  line_account_id TEXT,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('friend', 'conversation', 'historical')),
  subject_id TEXT,
  customer_number TEXT,
  opened_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  primary_category TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels_json)),
  inquiry_summary TEXT NOT NULL,
  resolution_summary TEXT,
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('open', 'answered', 'resolved', 'unknown')),
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('live', 'csv')),
  source_ref TEXT NOT NULL UNIQUE,
  classification_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inquiry_cases_account_opened
ON inquiry_cases(line_account_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiry_cases_account_category
ON inquiry_cases(line_account_id, primary_category, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiry_cases_customer
ON inquiry_cases(customer_number, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiry_cases_subject_activity
ON inquiry_cases(subject_kind, subject_id, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS inquiry_analysis_queue (
  id TEXT PRIMARY KEY,
  source_table TEXT NOT NULL CHECK (source_table IN ('messages_log', 'line_conversation_messages')),
  source_message_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error_kind TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_table, source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_inquiry_analysis_queue_status
ON inquiry_analysis_queue(status, next_attempt_at, created_at);

CREATE TRIGGER IF NOT EXISTS enqueue_personal_inquiry_analysis
AFTER INSERT ON messages_log
WHEN NEW.message_type = 'text'
  AND NEW.deleted_at IS NULL
  AND (
    (NEW.direction = 'incoming' AND NEW.source = 'user')
    OR (NEW.direction = 'outgoing' AND NEW.source IN ('manual', 'scheduled_manual', 'line_official'))
  )
BEGIN
  INSERT OR IGNORE INTO inquiry_analysis_queue
    (id, source_table, source_message_id, status, attempts, created_at, updated_at)
  VALUES
    ('messages_log:' || NEW.id, 'messages_log', NEW.id, 'pending', 0, NEW.created_at, NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS enqueue_conversation_inquiry_analysis
AFTER INSERT ON line_conversation_messages
WHEN NEW.message_type = 'text' AND NEW.deleted_at IS NULL
BEGIN
  INSERT OR IGNORE INTO inquiry_analysis_queue
    (id, source_table, source_message_id, status, attempts, created_at, updated_at)
  VALUES
    ('line_conversation_messages:' || NEW.id, 'line_conversation_messages', NEW.id, 'pending', 0, NEW.created_at, NEW.created_at);
END;
