-- Staff browser presence for showing who currently has L-Link open.

CREATE TABLE IF NOT EXISTS staff_presence (
  staff_id      TEXT PRIMARY KEY,
  staff_name    TEXT NOT NULL,
  staff_role    TEXT NOT NULL DEFAULT 'staff' CHECK (staff_role IN ('owner', 'admin', 'staff', 'secondary')),
  last_seen_at  TEXT NOT NULL,
  last_login_at TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_staff_presence_last_seen
  ON staff_presence(last_seen_at);
