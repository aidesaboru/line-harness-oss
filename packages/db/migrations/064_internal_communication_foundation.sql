-- Durable internal communication state.
-- Existing support/chat messages remain the source of truth and are never moved or deleted.

CREATE TABLE IF NOT EXISTS internal_conversations (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('support', 'chat', 'channel', 'dm', 'group_dm', 'announcement')),
  source_id       TEXT,
  title           TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  archived_at     TEXT,
  UNIQUE(kind, source_id)
);

CREATE INDEX IF NOT EXISTS idx_internal_conversations_account_updated
  ON internal_conversations(line_account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_internal_conversations_kind_source
  ON internal_conversations(kind, source_id);

CREATE TABLE IF NOT EXISTS internal_conversation_reads (
  conversation_id TEXT NOT NULL REFERENCES internal_conversations(id),
  staff_id         TEXT NOT NULL,
  last_read_at     TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY(conversation_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_internal_conversation_reads_staff
  ON internal_conversation_reads(staff_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS internal_message_mentions (
  source_type         TEXT NOT NULL CHECK (source_type IN ('support', 'chat', 'channel')),
  source_message_id   TEXT NOT NULL,
  staff_id            TEXT NOT NULL,
  staff_name_snapshot TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY(source_type, source_message_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_internal_message_mentions_staff
  ON internal_message_mentions(staff_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_notification_inbox (
  id                TEXT PRIMARY KEY,
  notification_key  TEXT NOT NULL,
  recipient_staff_id TEXT NOT NULL,
  line_account_id   TEXT,
  kind              TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  href              TEXT NOT NULL,
  source_created_at TEXT NOT NULL,
  read_at           TEXT,
  snoozed_until     TEXT,
  dismissed_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(recipient_staff_id, notification_key)
);

CREATE INDEX IF NOT EXISTS idx_app_notification_inbox_recipient
  ON app_notification_inbox(recipient_staff_id, dismissed_at, source_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_notification_inbox_account
  ON app_notification_inbox(recipient_staff_id, line_account_id, source_created_at DESC);

-- Build a non-destructive conversation index for every existing support message.
INSERT OR IGNORE INTO internal_conversations (
  id, line_account_id, kind, source_id, title, created_by, created_at, updated_at
)
SELECT
  'support:' || sim.case_id,
  sim.line_account_id,
  'support',
  sim.case_id,
  MAX(sc.title),
  NULL,
  MIN(sim.created_at),
  MAX(sim.created_at)
FROM support_internal_messages sim
LEFT JOIN support_cases sc ON sc.id = sim.case_id
GROUP BY sim.case_id, sim.line_account_id;

-- Build the same index for every existing one-to-one chat message.
INSERT OR IGNORE INTO internal_conversations (
  id, line_account_id, kind, source_id, title, created_by, created_at, updated_at
)
SELECT
  'chat:' || cim.friend_id,
  COALESCE(cim.line_account_id, f.line_account_id),
  'chat',
  cim.friend_id,
  MAX(f.display_name),
  NULL,
  MIN(cim.created_at),
  MAX(cim.created_at)
FROM chat_internal_messages cim
LEFT JOIN friends f ON f.id = cim.friend_id
GROUP BY cim.friend_id, COALESCE(cim.line_account_id, f.line_account_id);

-- Preserve legacy name mentions and add stable staff IDs only when the name is unique.
INSERT OR IGNORE INTO internal_message_mentions (
  source_type, source_message_id, staff_id, staff_name_snapshot, created_at
)
SELECT
  'support',
  sim.id,
  unique_staff.id,
  unique_staff.name,
  sim.created_at
FROM support_internal_messages sim
JOIN json_each(CASE WHEN json_valid(sim.mentions) THEN sim.mentions ELSE '[]' END) mention
JOIN (
  SELECT MIN(id) AS id, name
  FROM staff_members
  GROUP BY name
  HAVING COUNT(*) = 1
) unique_staff ON unique_staff.name = mention.value;

INSERT OR IGNORE INTO internal_message_mentions (
  source_type, source_message_id, staff_id, staff_name_snapshot, created_at
)
SELECT
  'chat',
  cim.id,
  unique_staff.id,
  unique_staff.name,
  cim.created_at
FROM chat_internal_messages cim
JOIN json_each(CASE WHEN json_valid(cim.mentions) THEN cim.mentions ELSE '[]' END) mention
JOIN (
  SELECT MIN(id) AS id, name
  FROM staff_members
  GROUP BY name
  HAVING COUNT(*) = 1
) unique_staff ON unique_staff.name = mention.value;

-- Old and new Workers both keep the conversation index current through these triggers.
CREATE TRIGGER IF NOT EXISTS trg_support_internal_messages_conversation_insert
AFTER INSERT ON support_internal_messages
BEGIN
  INSERT INTO internal_conversations (
    id, line_account_id, kind, source_id, title, created_by, created_at, updated_at
  )
  VALUES (
    'support:' || NEW.case_id,
    NEW.line_account_id,
    'support',
    NEW.case_id,
    (SELECT title FROM support_cases WHERE id = NEW.case_id),
    NEW.created_by,
    NEW.created_at,
    NEW.created_at
  )
  ON CONFLICT(id) DO UPDATE SET
    title = COALESCE(excluded.title, internal_conversations.title),
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_chat_internal_messages_conversation_insert
AFTER INSERT ON chat_internal_messages
BEGIN
  INSERT INTO internal_conversations (
    id, line_account_id, kind, source_id, title, created_by, created_at, updated_at
  )
  VALUES (
    'chat:' || NEW.friend_id,
    COALESCE(NEW.line_account_id, (SELECT line_account_id FROM friends WHERE id = NEW.friend_id)),
    'chat',
    NEW.friend_id,
    (SELECT display_name FROM friends WHERE id = NEW.friend_id),
    NEW.created_by,
    NEW.created_at,
    NEW.created_at
  )
  ON CONFLICT(id) DO UPDATE SET
    title = COALESCE(excluded.title, internal_conversations.title),
    updated_at = excluded.updated_at;
END;
