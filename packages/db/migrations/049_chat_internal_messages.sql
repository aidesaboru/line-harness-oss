-- Internal staff chat for one-to-one LINE conversations.
-- Customer-facing LINE messages stay in messages_log; these rows are visible only in the admin.

CREATE TABLE IF NOT EXISTS chat_internal_messages (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  parent_id       TEXT REFERENCES chat_internal_messages(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  mentions        TEXT NOT NULL DEFAULT '[]',
  created_by      TEXT,
  created_by_name TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_chat_internal_messages_friend
  ON chat_internal_messages(friend_id, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_internal_messages_parent
  ON chat_internal_messages(parent_id, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_internal_messages_account
  ON chat_internal_messages(line_account_id, created_at);

INSERT OR IGNORE INTO chat_internal_messages (
  id, friend_id, line_account_id, parent_id, body, mentions, created_by, created_by_name, created_at
)
SELECT
  'legacy-note-' || c.id,
  c.friend_id,
  COALESCE(c.line_account_id, f.line_account_id),
  NULL,
  TRIM(c.notes),
  '[]',
  NULL,
  '過去メモ',
  COALESCE(c.updated_at, c.created_at, strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
FROM chats c
LEFT JOIN friends f ON f.id = c.friend_id
WHERE c.notes IS NOT NULL
  AND TRIM(c.notes) != '';
