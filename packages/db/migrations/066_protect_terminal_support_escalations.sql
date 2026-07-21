-- Answered and closed secondary responses are immutable history.
-- Reopening creates a new pending row instead of rewriting the completed row.

CREATE TRIGGER IF NOT EXISTS protect_terminal_support_escalations_update
BEFORE UPDATE ON support_escalations
WHEN OLD.status IN ('answered', 'closed')
BEGIN
  SELECT RAISE(ABORT, 'completed support escalation is immutable');
END;
