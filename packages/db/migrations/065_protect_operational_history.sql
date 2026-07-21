-- Operational history is append-only. Use status/archive fields instead of physical deletion.
-- These guards also stop foreign-key cascades from removing customer conversations.

CREATE TRIGGER IF NOT EXISTS protect_support_cases_delete
BEFORE DELETE ON support_cases
BEGIN
  SELECT RAISE(ABORT, 'support_cases history is protected');
END;

CREATE TRIGGER IF NOT EXISTS protect_support_case_events_delete
BEFORE DELETE ON support_case_events
BEGIN
  SELECT RAISE(ABORT, 'support_case_events history is protected');
END;

CREATE TRIGGER IF NOT EXISTS protect_support_escalations_delete
BEFORE DELETE ON support_escalations
BEGIN
  SELECT RAISE(ABORT, 'support_escalations history is protected');
END;

CREATE TRIGGER IF NOT EXISTS protect_support_internal_messages_delete
BEFORE DELETE ON support_internal_messages
BEGIN
  SELECT RAISE(ABORT, 'support_internal_messages history is protected');
END;

CREATE TRIGGER IF NOT EXISTS protect_chat_internal_messages_delete
BEFORE DELETE ON chat_internal_messages
BEGIN
  SELECT RAISE(ABORT, 'chat_internal_messages history is protected');
END;

CREATE TRIGGER IF NOT EXISTS protect_messages_log_delete
BEFORE DELETE ON messages_log
BEGIN
  SELECT RAISE(ABORT, 'messages_log history is protected');
END;

CREATE TRIGGER IF NOT EXISTS protect_friends_delete
BEFORE DELETE ON friends
BEGIN
  SELECT RAISE(ABORT, 'friends history is protected');
END;
