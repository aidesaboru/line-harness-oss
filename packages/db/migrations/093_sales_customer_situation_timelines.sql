-- Sales-safe dated situation timelines with automatic status provenance.
-- Earlier v1/v2 summaries remain protected and auditable but are not read by
-- this version of the operator-facing route.
ALTER TABLE sales_customer_statuses
ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
CHECK (source IN ('manual', 'ai'));

ALTER TABLE sales_customer_statuses
ADD COLUMN source_fingerprint TEXT
CHECK (source_fingerprint IS NULL OR length(source_fingerprint) = 64);

ALTER TABLE sales_customer_status_events
ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
CHECK (source IN ('manual', 'ai'));

CREATE TABLE IF NOT EXISTS sales_customer_situation_timelines (
  id                    TEXT PRIMARY KEY,
  friend_id             TEXT REFERENCES friends(id) ON DELETE RESTRICT,
  conversation_id       TEXT REFERENCES line_conversations(id) ON DELETE RESTRICT,
  current_state         TEXT NOT NULL CHECK (length(trim(current_state)) BETWEEN 1 AND 500),
  recognized_status     TEXT NOT NULL CHECK (recognized_status IN (
                          'unreviewed', 'normal', 'attention', 'complaint',
                          'exit_pending', 'exited'
                        )),
  resolution_confirmed  INTEGER NOT NULL CHECK (resolution_confirmed IN (0, 1)),
  timeline_json         TEXT NOT NULL CHECK (
                          json_valid(timeline_json)
                          AND json_type(timeline_json) = 'array'
                          AND length(timeline_json) BETWEEN 2 AND 12000
                        ),
  generation_method     TEXT NOT NULL CHECK (generation_method = 'situation_timeline_v1'),
  ai_generated          INTEGER NOT NULL CHECK (ai_generated IN (0, 1)),
  model                 TEXT,
  prompt_version        TEXT NOT NULL CHECK (prompt_version = 'sales_situation_timeline_v1'),
  source_fingerprint    TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
  source_message_count  INTEGER NOT NULL CHECK (source_message_count BETWEEN 0 AND 80),
  source_from_at        TEXT,
  source_to_at          TEXT,
  input_char_count      INTEGER NOT NULL CHECK (input_char_count BETWEEN 0 AND 14000),
  prompt_tokens         INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens     INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  total_tokens          INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  attempt_count         INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
  version               INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  mutation_id           TEXT NOT NULL,
  updated_by            TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  updated_by_name       TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  CHECK ((friend_id IS NOT NULL) != (conversation_id IS NOT NULL)),
  CHECK ((source_message_count = 0) = (source_from_at IS NULL AND source_to_at IS NULL)),
  CHECK (
    (ai_generated = 1 AND model IS NOT NULL AND attempt_count BETWEEN 1 AND 2)
    OR (ai_generated = 0 AND model IS NULL AND attempt_count = 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_customer_situation_timeline_friend
ON sales_customer_situation_timelines(friend_id)
WHERE friend_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_customer_situation_timeline_conversation
ON sales_customer_situation_timelines(conversation_id)
WHERE conversation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_customer_situation_timeline_mutation
ON sales_customer_situation_timelines(mutation_id);

CREATE INDEX IF NOT EXISTS idx_sales_customer_situation_timeline_updated
ON sales_customer_situation_timelines(updated_at DESC);

CREATE TABLE IF NOT EXISTS sales_customer_situation_timeline_events (
  id                    TEXT PRIMARY KEY,
  timeline_id           TEXT NOT NULL REFERENCES sales_customer_situation_timelines(id) ON DELETE RESTRICT,
  current_state         TEXT NOT NULL CHECK (length(trim(current_state)) BETWEEN 1 AND 500),
  recognized_status     TEXT NOT NULL CHECK (recognized_status IN (
                          'unreviewed', 'normal', 'attention', 'complaint',
                          'exit_pending', 'exited'
                        )),
  resolution_confirmed  INTEGER NOT NULL CHECK (resolution_confirmed IN (0, 1)),
  timeline_json         TEXT NOT NULL CHECK (
                          json_valid(timeline_json)
                          AND json_type(timeline_json) = 'array'
                          AND length(timeline_json) BETWEEN 2 AND 12000
                        ),
  generation_method     TEXT NOT NULL CHECK (generation_method = 'situation_timeline_v1'),
  ai_generated          INTEGER NOT NULL CHECK (ai_generated IN (0, 1)),
  model                 TEXT,
  prompt_version        TEXT NOT NULL CHECK (prompt_version = 'sales_situation_timeline_v1'),
  source_fingerprint    TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
  source_message_count  INTEGER NOT NULL CHECK (source_message_count BETWEEN 0 AND 80),
  source_from_at        TEXT,
  source_to_at          TEXT,
  input_char_count      INTEGER NOT NULL CHECK (input_char_count BETWEEN 0 AND 14000),
  prompt_tokens         INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens     INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  total_tokens          INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  attempt_count         INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
  actor_id              TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  actor_name            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  CHECK ((source_message_count = 0) = (source_from_at IS NULL AND source_to_at IS NULL)),
  CHECK (
    (ai_generated = 1 AND model IS NOT NULL AND attempt_count BETWEEN 1 AND 2)
    OR (ai_generated = 0 AND model IS NULL AND attempt_count = 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_sales_customer_situation_timeline_events_timeline
ON sales_customer_situation_timeline_events(timeline_id, created_at DESC);

-- New human-readable text messages enqueue only the affected customer. The
-- one-minute delay coalesces a short burst into a single timeline refresh.
-- Lease columns let overlapping cron invocations avoid duplicate AI work;
-- a later message clears the lease so the newer source is never lost.
CREATE TABLE IF NOT EXISTS sales_customer_situation_queue (
  subject_kind    TEXT NOT NULL CHECK (subject_kind IN ('friend', 'conversation')),
  subject_id      TEXT NOT NULL,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  queued_at       TEXT NOT NULL,
  available_at    TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_kind TEXT,
  claim_token     TEXT,
  claimed_at      TEXT,
  PRIMARY KEY (subject_kind, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_customer_situation_queue_due
ON sales_customer_situation_queue(available_at, claimed_at);

CREATE TRIGGER IF NOT EXISTS enqueue_sales_customer_situation_friend_message
AFTER INSERT ON messages_log
WHEN NEW.message_type = 'text'
  AND length(trim(NEW.content)) > 0
  AND NEW.deleted_at IS NULL
  AND (NEW.delivery_type IS NULL OR NEW.delivery_type != 'test')
  AND (
    NEW.direction = 'incoming'
    OR (NEW.direction = 'outgoing' AND NEW.source IN ('manual', 'scheduled_manual', 'line_official'))
  )
BEGIN
  INSERT INTO sales_customer_situation_queue (
    subject_kind, subject_id, line_account_id, queued_at, available_at
  )
  SELECT
    'friend',
    NEW.friend_id,
    f.line_account_id,
    strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours'),
    strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours', '+1 minute')
  FROM friends f
  INNER JOIN line_accounts la ON la.id = f.line_account_id AND la.is_active = 1
  WHERE f.id = NEW.friend_id
  ON CONFLICT(subject_kind, subject_id) DO UPDATE SET
    line_account_id = excluded.line_account_id,
    queued_at = excluded.queued_at,
    available_at = excluded.available_at,
    attempts = 0,
    last_error_kind = NULL,
    claim_token = NULL,
    claimed_at = NULL;
END;

CREATE TRIGGER IF NOT EXISTS enqueue_sales_customer_situation_conversation_message
AFTER INSERT ON line_conversation_messages
WHEN NEW.message_type = 'text'
  AND length(trim(NEW.content)) > 0
  AND NEW.deleted_at IS NULL
  AND (
    NEW.direction = 'incoming'
    OR (NEW.direction = 'outgoing' AND NEW.source IN ('manual', 'scheduled_manual', 'line_official'))
  )
BEGIN
  INSERT INTO sales_customer_situation_queue (
    subject_kind, subject_id, line_account_id, queued_at, available_at
  )
  SELECT
    'conversation',
    NEW.conversation_id,
    lc.line_account_id,
    strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours'),
    strftime('%Y-%m-%dT%H:%M:%f+09:00', 'now', '+9 hours', '+1 minute')
  FROM line_conversations lc
  INNER JOIN line_accounts la ON la.id = lc.line_account_id AND la.is_active = 1
  WHERE lc.id = NEW.conversation_id
    AND lc.source_type IN ('group', 'room')
  ON CONFLICT(subject_kind, subject_id) DO UPDATE SET
    line_account_id = excluded.line_account_id,
    queued_at = excluded.queued_at,
    available_at = excluded.available_at,
    attempts = 0,
    last_error_kind = NULL,
    claim_token = NULL,
    claimed_at = NULL;
END;

CREATE TRIGGER IF NOT EXISTS protect_sales_customer_situation_timelines_delete
BEFORE DELETE ON sales_customer_situation_timelines
BEGIN
  SELECT RAISE(ABORT, 'sales customer situation timeline history is protected');
END;

CREATE TRIGGER IF NOT EXISTS protect_sales_customer_situation_timeline_events_update
BEFORE UPDATE ON sales_customer_situation_timeline_events
BEGIN
  SELECT RAISE(ABORT, 'sales customer situation timeline events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS protect_sales_customer_situation_timeline_events_delete
BEFORE DELETE ON sales_customer_situation_timeline_events
BEGIN
  SELECT RAISE(ABORT, 'sales customer situation timeline events are append-only');
END;
