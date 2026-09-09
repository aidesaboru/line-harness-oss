-- Sales-safe customer state: sales-only staff can inspect this surface without
-- receiving access to LINE conversations, support notes, or operational tools.
ALTER TABLE staff_members
ADD COLUMN sales_only INTEGER NOT NULL DEFAULT 0
CHECK (sales_only IN (0, 1));

CREATE TABLE IF NOT EXISTS sales_customer_statuses (
  id                TEXT PRIMARY KEY,
  friend_id         TEXT REFERENCES friends(id) ON DELETE RESTRICT,
  conversation_id   TEXT REFERENCES line_conversations(id) ON DELETE RESTRICT,
  status            TEXT NOT NULL CHECK (status IN (
                      'normal',
                      'attention',
                      'complaint',
                      'exit_pending',
                      'exited'
                    )),
  summary           TEXT NOT NULL CHECK (
                      length(trim(summary)) BETWEEN 1 AND 1000
                    ),
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  mutation_id       TEXT NOT NULL,
  updated_by        TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  updated_by_name   TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  CHECK ((friend_id IS NOT NULL) != (conversation_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_customer_status_friend
ON sales_customer_statuses(friend_id)
WHERE friend_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_customer_status_conversation
ON sales_customer_statuses(conversation_id)
WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_customer_status_priority
ON sales_customer_statuses(status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_customer_status_mutation
ON sales_customer_statuses(mutation_id);

CREATE TABLE IF NOT EXISTS sales_customer_status_events (
  id                TEXT PRIMARY KEY,
  status_id         TEXT NOT NULL REFERENCES sales_customer_statuses(id) ON DELETE RESTRICT,
  from_status       TEXT NOT NULL CHECK (from_status IN (
                      'unreviewed',
                      'normal',
                      'attention',
                      'complaint',
                      'exit_pending',
                      'exited'
                    )),
  to_status         TEXT NOT NULL CHECK (to_status IN (
                      'normal',
                      'attention',
                      'complaint',
                      'exit_pending',
                      'exited'
                    )),
  summary           TEXT NOT NULL CHECK (
                      length(trim(summary)) BETWEEN 1 AND 1000
                    ),
  actor_id          TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  actor_name        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_sales_customer_status_events_status
ON sales_customer_status_events(status_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS protect_sales_customer_statuses_delete
BEFORE DELETE ON sales_customer_statuses
BEGIN
  SELECT RAISE(ABORT, 'sales customer status history is protected');
END;

CREATE TRIGGER IF NOT EXISTS protect_sales_customer_status_events_update
BEFORE UPDATE ON sales_customer_status_events
BEGIN
  SELECT RAISE(ABORT, 'sales customer status events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS protect_sales_customer_status_events_delete
BEFORE DELETE ON sales_customer_status_events
BEGIN
  SELECT RAISE(ABORT, 'sales customer status events are append-only');
END;
