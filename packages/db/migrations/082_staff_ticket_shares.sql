-- Allow explicitly paired primary-support staff to cover each other's tickets.
-- A single row represents a mutual relationship; broad staff visibility stays disabled.
-- Install the rollback guard in the first migration of this release. Until the
-- new Worker is live, an old bundle can still issue DELETE FROM staff_members;
-- turning it into a soft disable here prevents cascades during the rolling
-- migration window as well as after a rollback.
CREATE TRIGGER IF NOT EXISTS legacy_staff_delete_soft_disable
BEFORE DELETE ON staff_members
BEGIN
  UPDATE staff_members SET is_active = 0 WHERE id = OLD.id;
  SELECT RAISE(IGNORE);
END;

CREATE TABLE IF NOT EXISTS staff_ticket_shares (
  staff_a_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  staff_b_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (staff_a_id, staff_b_id),
  CHECK (staff_a_id < staff_b_id)
);

CREATE INDEX IF NOT EXISTS idx_staff_ticket_shares_staff_b
  ON staff_ticket_shares(staff_b_id, staff_a_id);
