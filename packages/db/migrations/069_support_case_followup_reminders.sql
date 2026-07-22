-- Internal follow-up reminders for support cases.
-- Reminder configuration is retained and every acknowledgement is appended as history.

CREATE TABLE IF NOT EXISTS support_case_followup_reminders (
  id                  TEXT PRIMARY KEY,
  case_id             TEXT NOT NULL UNIQUE REFERENCES support_cases(id) ON DELETE RESTRICT,
  line_account_id     TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  owner_staff_id      TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  owner_name          TEXT NOT NULL,
  interval_days       INTEGER NOT NULL CHECK (interval_days BETWEEN 1 AND 365),
  next_due_at         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'disabled')),
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_confirmed_at   TEXT,
  last_confirmed_by   TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  last_confirmed_name TEXT,
  created_by          TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  created_by_name     TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_support_case_followup_due
  ON support_case_followup_reminders(owner_staff_id, status, next_due_at);

CREATE INDEX IF NOT EXISTS idx_support_case_followup_account
  ON support_case_followup_reminders(line_account_id, status, updated_at DESC);

CREATE TRIGGER IF NOT EXISTS protect_support_case_followup_reminders_delete
BEFORE DELETE ON support_case_followup_reminders
BEGIN
  SELECT RAISE(ABORT, 'support case follow-up reminders cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS support_case_followup_reminder_events (
  id            TEXT PRIMARY KEY,
  reminder_id   TEXT NOT NULL REFERENCES support_case_followup_reminders(id) ON DELETE RESTRICT,
  case_id       TEXT NOT NULL REFERENCES support_cases(id) ON DELETE RESTRICT,
  action        TEXT NOT NULL CHECK (action IN ('configured', 'reconfigured', 'confirmed', 'completed', 'disabled')),
  metadata      TEXT NOT NULL DEFAULT '{}',
  actor_id      TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  actor_name    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_support_case_followup_events_reminder
  ON support_case_followup_reminder_events(reminder_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS protect_support_case_followup_events_update
BEFORE UPDATE ON support_case_followup_reminder_events
BEGIN
  SELECT RAISE(ABORT, 'support case follow-up reminder events cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS protect_support_case_followup_events_delete
BEFORE DELETE ON support_case_followup_reminder_events
BEGIN
  SELECT RAISE(ABORT, 'support case follow-up reminder events cannot be deleted');
END;
