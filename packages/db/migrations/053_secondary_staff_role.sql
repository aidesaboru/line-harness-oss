-- Allow staff accounts dedicated to secondary escalation work only.
-- SQLite cannot widen a CHECK constraint in place, so rebuild the table.

CREATE TABLE staff_members_new (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff', 'secondary')),
  api_key    TEXT UNIQUE NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

INSERT INTO staff_members_new (
  id,
  name,
  email,
  role,
  api_key,
  is_active,
  created_at,
  updated_at
)
SELECT
  id,
  name,
  email,
  role,
  api_key,
  is_active,
  created_at,
  updated_at
FROM staff_members;

DROP TABLE staff_members;
ALTER TABLE staff_members_new RENAME TO staff_members;

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_members_api_key ON staff_members(api_key);
CREATE INDEX IF NOT EXISTS idx_staff_members_role ON staff_members(role);
