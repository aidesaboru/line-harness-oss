-- Core account and chat records are never physically deleted.
-- Disable a LINE account with is_active = 0 and retain chat state/history.

CREATE TRIGGER IF NOT EXISTS protect_line_accounts_delete
BEFORE DELETE ON line_accounts
BEGIN
  SELECT RAISE(ABORT, 'line_accounts history is protected');
END;

CREATE TRIGGER IF NOT EXISTS protect_chats_delete
BEFORE DELETE ON chats
BEGIN
  SELECT RAISE(ABORT, 'chats history is protected');
END;
