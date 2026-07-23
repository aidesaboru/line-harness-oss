-- Add append-only discussion to operational tasks without changing existing task rows.

CREATE TABLE IF NOT EXISTS internal_task_comments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES internal_tasks(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_by  TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_internal_task_comments_task
  ON internal_task_comments(task_id, created_at, id);

CREATE TRIGGER IF NOT EXISTS protect_internal_task_comments_update
BEFORE UPDATE ON internal_task_comments
BEGIN
  SELECT RAISE(ABORT, 'internal task comments cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS protect_internal_task_comments_delete
BEFORE DELETE ON internal_task_comments
BEGIN
  SELECT RAISE(ABORT, 'internal task comments cannot be deleted');
END;
