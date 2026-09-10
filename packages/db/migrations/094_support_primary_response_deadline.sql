-- Customer-response promise deadline and durable pre-deadline Slack delivery.
-- Existing cases intentionally remain NULL to avoid an unexpected alert flood.

ALTER TABLE support_cases
ADD COLUMN customer_response_due_at TEXT;

ALTER TABLE support_cases
ADD COLUMN customer_response_reminder_at TEXT;

-- Keep ticket creation compatible with the previous Worker during rollout or
-- rollback. A newly accepted case defaults to 18:00 JST three weekdays later.
CREATE TRIGGER IF NOT EXISTS trg_support_cases_default_customer_response_deadline
AFTER INSERT ON support_cases
WHEN NEW.customer_response_due_at IS NULL
BEGIN
  UPDATE support_cases
  SET customer_response_due_at = date(
        substr(NEW.created_at, 1, 10),
        CASE strftime('%w', substr(NEW.created_at, 1, 10))
          WHEN '0' THEN '+3 days'
          WHEN '1' THEN '+3 days'
          WHEN '2' THEN '+3 days'
          WHEN '3' THEN '+5 days'
          WHEN '4' THEN '+5 days'
          WHEN '5' THEN '+5 days'
          WHEN '6' THEN '+4 days'
        END
      ) || 'T18:00:00.000+09:00'
  WHERE id = NEW.id;

  UPDATE support_cases
  SET customer_response_reminder_at = date(
        substr(customer_response_due_at, 1, 10),
        CASE strftime('%w', substr(customer_response_due_at, 1, 10))
          WHEN '1' THEN '-3 days'
          ELSE '-1 day'
        END
      ) || 'T10:00:00.000+09:00'
  WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_support_cases_customer_response_due
ON support_cases(customer_response_due_at, status);

CREATE TABLE IF NOT EXISTS support_primary_response_slack_outbox (
  id                 TEXT PRIMARY KEY,
  case_id            TEXT NOT NULL REFERENCES support_cases(id) ON DELETE RESTRICT,
  line_account_id    TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  response_due_at    TEXT NOT NULL,
  reminder_at        TEXT NOT NULL,
  recipient_staff_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'sending', 'failed', 'dead_letter', 'cancelled', 'sent')),
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at    TEXT NOT NULL,
  claim_token        TEXT,
  last_error_code    TEXT,
  slack_message_ts   TEXT,
  sent_at            TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (case_id, response_due_at, recipient_staff_id)
);

CREATE INDEX IF NOT EXISTS idx_support_primary_response_slack_delivery
ON support_primary_response_slack_outbox(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_support_primary_response_slack_account
ON support_primary_response_slack_outbox(line_account_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS protect_support_primary_response_slack_outbox_delete
BEFORE DELETE ON support_primary_response_slack_outbox
BEGIN
  SELECT RAISE(ABORT, 'primary response Slack notification outbox cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS protect_support_primary_response_slack_outbox_sent_status
BEFORE UPDATE OF status ON support_primary_response_slack_outbox
WHEN OLD.status = 'sent' AND NEW.status != 'sent'
BEGIN
  SELECT RAISE(ABORT, 'sent primary response Slack notification cannot be reopened');
END;
