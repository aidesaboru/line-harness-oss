-- Add Trello-style workflow fields without changing the existing open/done
-- contract. Older Workers can continue to read and update status while newer
-- clients use workflow_status.
ALTER TABLE internal_tasks
ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'todo'
CHECK (workflow_status IN ('todo', 'in_progress', 'review', 'done'));

ALTER TABLE internal_tasks
ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'
CHECK (priority IN ('low', 'medium', 'high', 'urgent'));

ALTER TABLE internal_tasks
ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;

ALTER TABLE internal_tasks
ADD COLUMN version INTEGER NOT NULL DEFAULT 1
CHECK (version >= 1);

-- Unique marker for one optimistic-concurrency mutation. Follow-up event and
-- assignee statements in the same D1 batch verify this marker so a losing
-- concurrent request cannot append history for another request's update.
ALTER TABLE internal_tasks
ADD COLUMN last_mutation_id TEXT;

ALTER TABLE internal_tasks
ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'
CHECK (json_valid(labels) AND json_type(labels) = 'array');

UPDATE internal_tasks
SET workflow_status = CASE status WHEN 'done' THEN 'done' ELSE 'todo' END;

-- During a staged rollout (or rollback), the previous Worker only updates the
-- legacy status column. Mirror those legacy-only writes into the new workflow
-- state. New Workers update both columns, so the WHEN clause leaves them alone.
CREATE TRIGGER IF NOT EXISTS trg_internal_tasks_legacy_status_sync
AFTER UPDATE OF status ON internal_tasks
WHEN NEW.status != OLD.status
  AND NEW.workflow_status = OLD.workflow_status
BEGIN
  UPDATE internal_tasks
  SET workflow_status = CASE NEW.status WHEN 'done' THEN 'done' ELSE 'todo' END,
      version = version + 1
  WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_internal_tasks_workflow_order
ON internal_tasks(line_account_id, workflow_status, sort_order, updated_at DESC);

CREATE TABLE IF NOT EXISTS internal_task_checklist_items (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES internal_tasks(id) ON DELETE RESTRICT,
  body              TEXT NOT NULL,
  is_completed      INTEGER NOT NULL DEFAULT 0 CHECK (is_completed IN (0, 1)),
  sort_order        REAL NOT NULL DEFAULT 0,
  created_by        TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  created_by_name   TEXT,
  completed_by      TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  completed_by_name TEXT,
  completed_at      TEXT,
  removed_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_internal_task_checklist_items_task
ON internal_task_checklist_items(task_id, removed_at, sort_order, created_at);
