-- Deterministic, sales-safe recent-situation overviews. These records are
-- deliberately independent from manually selected sales statuses.
CREATE TABLE IF NOT EXISTS sales_customer_overviews (
  id                 TEXT PRIMARY KEY,
  friend_id          TEXT REFERENCES friends(id) ON DELETE RESTRICT,
  conversation_id    TEXT REFERENCES line_conversations(id) ON DELETE RESTRICT,
  overview           TEXT NOT NULL CHECK (
                       length(trim(overview)) BETWEEN 1 AND 2000
                     ),
  period_days        INTEGER NOT NULL DEFAULT 90 CHECK (period_days = 90),
  topic_codes        TEXT NOT NULL DEFAULT '[]' CHECK (
                       json_valid(topic_codes) AND json_type(topic_codes) = 'array'
                     ),
  generation_method  TEXT NOT NULL CHECK (generation_method = 'rules_v1'),
  source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  mutation_id        TEXT NOT NULL,
  updated_by         TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  updated_by_name    TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  CHECK ((friend_id IS NOT NULL) != (conversation_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_customer_overview_friend
ON sales_customer_overviews(friend_id)
WHERE friend_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_customer_overview_conversation
ON sales_customer_overviews(conversation_id)
WHERE conversation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_customer_overview_mutation
ON sales_customer_overviews(mutation_id);

CREATE INDEX IF NOT EXISTS idx_sales_customer_overview_updated
ON sales_customer_overviews(updated_at DESC);

CREATE TABLE IF NOT EXISTS sales_customer_overview_events (
  id                 TEXT PRIMARY KEY,
  overview_id        TEXT NOT NULL REFERENCES sales_customer_overviews(id) ON DELETE RESTRICT,
  overview           TEXT NOT NULL CHECK (
                       length(trim(overview)) BETWEEN 1 AND 2000
                     ),
  period_days        INTEGER NOT NULL CHECK (period_days = 90),
  topic_codes        TEXT NOT NULL CHECK (
                       json_valid(topic_codes) AND json_type(topic_codes) = 'array'
                     ),
  generation_method  TEXT NOT NULL CHECK (generation_method = 'rules_v1'),
  source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
  actor_id           TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  actor_name         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_sales_customer_overview_events_overview
ON sales_customer_overview_events(overview_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS protect_sales_customer_overviews_delete
BEFORE DELETE ON sales_customer_overviews
BEGIN
  SELECT RAISE(ABORT, 'sales customer overview history is protected');
END;

CREATE TRIGGER IF NOT EXISTS protect_sales_customer_overview_events_update
BEFORE UPDATE ON sales_customer_overview_events
BEGIN
  SELECT RAISE(ABORT, 'sales customer overview events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS protect_sales_customer_overview_events_delete
BEFORE DELETE ON sales_customer_overview_events
BEGIN
  SELECT RAISE(ABORT, 'sales customer overview events are append-only');
END;
