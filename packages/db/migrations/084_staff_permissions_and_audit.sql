-- Keep the existing role values stable while separating secondary read-only
-- access from secondary response access.
ALTER TABLE staff_members
ADD COLUMN secondary_can_respond INTEGER NOT NULL DEFAULT 0
CHECK (secondary_can_respond IN (0, 1));

-- Ticket-share rows are retired instead of deleted so past coverage can be
-- reconstructed without touching support cases or their event history.
ALTER TABLE staff_ticket_shares
ADD COLUMN removed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_staff_ticket_shares_active
ON staff_ticket_shares(staff_a_id, staff_b_id)
WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS staff_member_events (
  id               TEXT PRIMARY KEY,
  staff_id         TEXT NOT NULL REFERENCES staff_members(id) ON DELETE RESTRICT,
  action           TEXT NOT NULL CHECK (action IN (
                     'created',
                     'updated',
                     'disabled',
                     'enabled',
                     'api_key_regenerated'
                   )),
  metadata         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  actor_id         TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  actor_name       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_staff_member_events_staff
ON staff_member_events(staff_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS protect_staff_member_events_update
BEFORE UPDATE ON staff_member_events
BEGIN
  SELECT RAISE(ABORT, 'staff member events cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS protect_staff_member_events_delete
BEFORE DELETE ON staff_member_events
BEGIN
  SELECT RAISE(ABORT, 'staff member events cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS staff_ticket_share_events (
  id               TEXT PRIMARY KEY,
  staff_a_id       TEXT NOT NULL REFERENCES staff_members(id) ON DELETE RESTRICT,
  staff_b_id       TEXT NOT NULL REFERENCES staff_members(id) ON DELETE RESTRICT,
  action           TEXT NOT NULL CHECK (action IN ('granted', 'revoked')),
  actor_id         TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  actor_name       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  CHECK (staff_a_id < staff_b_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_ticket_share_events_pair
ON staff_ticket_share_events(staff_a_id, staff_b_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS protect_staff_ticket_share_events_update
BEFORE UPDATE ON staff_ticket_share_events
BEGIN
  SELECT RAISE(ABORT, 'staff ticket share events cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS protect_staff_ticket_share_events_delete
BEFORE DELETE ON staff_ticket_share_events
BEGIN
  SELECT RAISE(ABORT, 'staff ticket share events cannot be deleted');
END;

-- Old Worker bundles physically deleted staff rows. During an additive deploy
-- or rollback, translate that legacy DELETE into a soft disable before any
-- ON DELETE CASCADE can erase task assignments, shares, or history.
CREATE TRIGGER IF NOT EXISTS legacy_staff_delete_soft_disable
BEFORE DELETE ON staff_members
BEGIN
  UPDATE staff_members SET is_active = 0 WHERE id = OLD.id;
  SELECT RAISE(IGNORE);
END;
