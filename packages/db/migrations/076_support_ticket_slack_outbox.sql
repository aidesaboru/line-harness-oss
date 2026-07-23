-- Durable Slack delivery queue for newly created secondary-support tickets.
-- The queue row is written in the same batch as the ticket and retried by cron.

ALTER TABLE staff_members ADD COLUMN slack_user_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_members_slack_user_id
  ON staff_members(slack_user_id)
  WHERE slack_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS support_slack_notification_outbox (
  id                TEXT PRIMARY KEY,
  case_id           TEXT NOT NULL REFERENCES support_cases(id) ON DELETE RESTRICT,
  line_account_id   TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('ticket_created')),
  payload           TEXT NOT NULL CHECK (json_valid(payload)),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending', 'failed', 'dead_letter', 'sent')),
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at   TEXT NOT NULL,
  claim_token       TEXT,
  last_error_code   TEXT,
  slack_message_ts  TEXT,
  sent_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (case_id, notification_type)
);

CREATE INDEX IF NOT EXISTS idx_support_slack_outbox_delivery
  ON support_slack_notification_outbox(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_support_slack_outbox_account
  ON support_slack_notification_outbox(line_account_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS protect_support_slack_outbox_delete
BEFORE DELETE ON support_slack_notification_outbox
BEGIN
  SELECT RAISE(ABORT, 'support Slack notification outbox cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS protect_support_slack_outbox_sent_status
BEFORE UPDATE OF status ON support_slack_notification_outbox
WHEN OLD.status = 'sent' AND NEW.status != 'sent'
BEGIN
  SELECT RAISE(ABORT, 'sent support Slack notification cannot be reopened');
END;
