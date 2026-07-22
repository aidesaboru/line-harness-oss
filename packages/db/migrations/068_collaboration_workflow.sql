-- Additive collaboration workflow foundation.
-- Source messages and operational records stay immutable. User actions are appended as events.

ALTER TABLE support_escalations ADD COLUMN assignee_staff_id TEXT REFERENCES staff_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_support_escalations_assignee_staff
  ON support_escalations(assignee_staff_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS internal_message_events (
  id                 TEXT PRIMARY KEY,
  source_type        TEXT NOT NULL CHECK (source_type IN ('support', 'chat')),
  source_message_id  TEXT NOT NULL,
  version            INTEGER NOT NULL,
  action             TEXT NOT NULL CHECK (action IN ('edit', 'delete')),
  body               TEXT,
  mentions           TEXT NOT NULL DEFAULT '[]',
  mention_staff_ids  TEXT NOT NULL DEFAULT '[]',
  reason             TEXT,
  actor_id           TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  actor_name         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (source_type, source_message_id, version)
);

CREATE INDEX IF NOT EXISTS idx_internal_message_events_source
  ON internal_message_events(source_type, source_message_id, version DESC);

CREATE TRIGGER IF NOT EXISTS protect_internal_message_events_update
BEFORE UPDATE ON internal_message_events
BEGIN
  SELECT RAISE(ABORT, 'internal message events cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS protect_internal_message_events_delete
BEFORE DELETE ON internal_message_events
BEGIN
  SELECT RAISE(ABORT, 'internal message events cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS internal_message_bookmark_events (
  id                 TEXT PRIMARY KEY,
  source_type        TEXT NOT NULL CHECK (source_type IN ('support', 'chat')),
  source_message_id  TEXT NOT NULL,
  staff_id           TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  action             TEXT NOT NULL CHECK (action IN ('add', 'remove')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_internal_message_bookmark_events_staff
  ON internal_message_bookmark_events(staff_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_internal_message_bookmark_events_message
  ON internal_message_bookmark_events(source_type, source_message_id, staff_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS protect_internal_message_bookmark_events_update
BEFORE UPDATE ON internal_message_bookmark_events
BEGIN
  SELECT RAISE(ABORT, 'bookmark events cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS protect_internal_message_bookmark_events_delete
BEFORE DELETE ON internal_message_bookmark_events
BEGIN
  SELECT RAISE(ABORT, 'bookmark events cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS internal_tasks (
  id                 TEXT PRIMARY KEY,
  line_account_id    TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  source_type        TEXT NOT NULL CHECK (source_type IN ('support', 'chat')),
  source_id          TEXT NOT NULL,
  source_message_id  TEXT,
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  due_at              TEXT,
  created_by          TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  created_by_name     TEXT,
  completed_by       TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  completed_by_name  TEXT,
  completed_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_internal_tasks_account_status
  ON internal_tasks(line_account_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_internal_tasks_source
  ON internal_tasks(source_type, source_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS protect_internal_tasks_delete
BEFORE DELETE ON internal_tasks
BEGIN
  SELECT RAISE(ABORT, 'internal tasks cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS internal_task_assignees (
  task_id          TEXT NOT NULL REFERENCES internal_tasks(id) ON DELETE CASCADE,
  staff_id         TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  staff_name       TEXT NOT NULL,
  assigned_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  removed_at       TEXT,
  PRIMARY KEY (task_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_internal_task_assignees_staff
  ON internal_task_assignees(staff_id, removed_at, assigned_at DESC);

CREATE TABLE IF NOT EXISTS internal_task_events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES internal_tasks(id) ON DELETE CASCADE,
  action      TEXT NOT NULL CHECK (action IN ('created', 'completed', 'reopened', 'updated')),
  metadata    TEXT NOT NULL DEFAULT '{}',
  actor_id    TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  actor_name  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_internal_task_events_task
  ON internal_task_events(task_id, created_at);

CREATE TRIGGER IF NOT EXISTS protect_internal_task_events_update
BEFORE UPDATE ON internal_task_events
BEGIN
  SELECT RAISE(ABORT, 'internal task events cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS protect_internal_task_events_delete
BEFORE DELETE ON internal_task_events
BEGIN
  SELECT RAISE(ABORT, 'internal task events cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS support_case_attachments (
  id               TEXT PRIMARY KEY,
  case_id          TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  line_account_id  TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  r2_key           TEXT NOT NULL,
  file_name        TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  created_by_name  TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_support_case_attachments_case
  ON support_case_attachments(case_id, created_at);

CREATE TRIGGER IF NOT EXISTS protect_support_case_attachments_delete
BEFORE DELETE ON support_case_attachments
BEGIN
  SELECT RAISE(ABORT, 'support case attachments cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS chat_confirmation_events (
  id                    TEXT PRIMARY KEY,
  friend_id             TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  line_account_id       TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  staff_id              TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  staff_name            TEXT NOT NULL,
  confirmed_message_id  TEXT NOT NULL,
  confirmed_message_at  TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (friend_id, staff_id, confirmed_message_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_confirmation_events_staff
  ON chat_confirmation_events(staff_id, friend_id, confirmed_message_at DESC, confirmed_message_id DESC);

CREATE TRIGGER IF NOT EXISTS protect_chat_confirmation_events_update
BEFORE UPDATE ON chat_confirmation_events
BEGIN
  SELECT RAISE(ABORT, 'chat confirmation events cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS protect_chat_confirmation_events_delete
BEFORE DELETE ON chat_confirmation_events
BEGIN
  SELECT RAISE(ABORT, 'chat confirmation events cannot be deleted');
END;
