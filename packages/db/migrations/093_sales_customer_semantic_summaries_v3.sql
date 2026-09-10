-- Privacy- and specificity-gated conversation summaries. Version 3 is isolated
-- from earlier semantic tables so rejected output remains auditable but never
-- appears in operator-facing views.
CREATE TABLE IF NOT EXISTS sales_customer_semantic_summaries_v3 (
  id                    TEXT PRIMARY KEY,
  friend_id             TEXT REFERENCES friends(id) ON DELETE RESTRICT,
  conversation_id       TEXT REFERENCES line_conversations(id) ON DELETE RESTRICT,
  summary               TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 4000),
  generation_method     TEXT NOT NULL CHECK (generation_method = 'semantic_v3'),
  ai_generated          INTEGER NOT NULL CHECK (ai_generated IN (0, 1)),
  model                 TEXT,
  prompt_version        TEXT NOT NULL CHECK (prompt_version = 'sales_conversation_summary_v3'),
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_customer_semantic_summary_v3_friend
ON sales_customer_semantic_summaries_v3(friend_id)
WHERE friend_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_customer_semantic_summary_v3_conversation
ON sales_customer_semantic_summaries_v3(conversation_id)
WHERE conversation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_customer_semantic_summary_v3_mutation
ON sales_customer_semantic_summaries_v3(mutation_id);

CREATE INDEX IF NOT EXISTS idx_sales_customer_semantic_summary_v3_updated
ON sales_customer_semantic_summaries_v3(updated_at DESC);

CREATE TABLE IF NOT EXISTS sales_customer_semantic_summary_events_v3 (
  id                    TEXT PRIMARY KEY,
  summary_id            TEXT NOT NULL REFERENCES sales_customer_semantic_summaries_v3(id) ON DELETE RESTRICT,
  summary               TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 4000),
  generation_method     TEXT NOT NULL CHECK (generation_method = 'semantic_v3'),
  ai_generated          INTEGER NOT NULL CHECK (ai_generated IN (0, 1)),
  model                 TEXT,
  prompt_version        TEXT NOT NULL CHECK (prompt_version = 'sales_conversation_summary_v3'),
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

CREATE INDEX IF NOT EXISTS idx_sales_customer_semantic_summary_events_v3_summary
ON sales_customer_semantic_summary_events_v3(summary_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS protect_sales_customer_semantic_summaries_v3_delete
BEFORE DELETE ON sales_customer_semantic_summaries_v3
BEGIN
  SELECT RAISE(ABORT, 'sales customer semantic summary v3 history is protected');
END;

CREATE TRIGGER IF NOT EXISTS protect_sales_customer_semantic_summary_events_v3_update
BEFORE UPDATE ON sales_customer_semantic_summary_events_v3
BEGIN
  SELECT RAISE(ABORT, 'sales customer semantic summary v3 events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS protect_sales_customer_semantic_summary_events_v3_delete
BEFORE DELETE ON sales_customer_semantic_summary_events_v3
BEGIN
  SELECT RAISE(ABORT, 'sales customer semantic summary v3 events are append-only');
END;
