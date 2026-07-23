-- Repeatable reminder completion history for operator chats.
-- This table is append-only so every button press remains auditable.

CREATE TABLE IF NOT EXISTS chat_reminder_completion_events (
  id                    TEXT PRIMARY KEY,
  friend_id             TEXT NOT NULL REFERENCES friends(id) ON DELETE RESTRICT,
  line_account_id       TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  staff_id              TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  staff_name            TEXT NOT NULL,
  confirmed_message_id  TEXT NOT NULL,
  confirmed_message_at  TEXT NOT NULL,
  completed_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_reminder_completion_friend_staff
  ON chat_reminder_completion_events(friend_id, staff_id, completed_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS protect_chat_reminder_completion_events_update
BEFORE UPDATE ON chat_reminder_completion_events
BEGIN
  SELECT RAISE(ABORT, 'chat reminder completion events cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS protect_chat_reminder_completion_events_delete
BEFORE DELETE ON chat_reminder_completion_events
BEGIN
  SELECT RAISE(ABORT, 'chat reminder completion events cannot be deleted');
END;
