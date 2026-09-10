-- Keep display names for the UI and historical readability, while using
-- immutable staff IDs for authorization whenever the assignee can be resolved.
ALTER TABLE support_cases
ADD COLUMN primary_assignee_staff_id TEXT REFERENCES staff_members(id) ON DELETE SET NULL;

ALTER TABLE support_cases
ADD COLUMN escalation_assignee_staff_id TEXT REFERENCES staff_members(id) ON DELETE SET NULL;

UPDATE support_cases
SET primary_assignee_staff_id = (
  SELECT sm.id
  FROM staff_members sm
  WHERE sm.name = support_cases.primary_assignee
)
WHERE primary_assignee_staff_id IS NULL
  AND primary_assignee IS NOT NULL
  AND primary_assignee != ''
  AND (SELECT COUNT(*) FROM staff_members sm WHERE sm.name = support_cases.primary_assignee) = 1;

UPDATE support_cases
SET escalation_assignee_staff_id = (
  SELECT sm.id
  FROM staff_members sm
  WHERE sm.name = support_cases.escalation_assignee
)
WHERE escalation_assignee_staff_id IS NULL
  AND escalation_assignee IS NOT NULL
  AND escalation_assignee != ''
  AND (SELECT COUNT(*) FROM staff_members sm WHERE sm.name = support_cases.escalation_assignee) = 1;

-- Migration 068 introduced this ID column without a historical backfill.
-- Resolve only names that are unique across all staff history. Ambiguous names
-- remain NULL for explicit operator review rather than granting the wrong user.
-- Answered and closed rows are immutable audit history (migration 066), so keep
-- those rows untouched and let the Worker use its unique-name legacy fallback.
UPDATE support_escalations
SET assignee_staff_id = (
  SELECT sm.id
  FROM staff_members sm
  WHERE sm.name = support_escalations.assignee
)
WHERE assignee_staff_id IS NULL
  AND status NOT IN ('answered', 'closed')
  AND assignee IS NOT NULL
  AND assignee != ''
  AND (SELECT COUNT(*) FROM staff_members sm WHERE sm.name = support_escalations.assignee) = 1;

-- Keep writes made by the previous Worker compatible during a staged rollout
-- and after rollback. A name is converted to an ID only when it is unique
-- across all staff records; duplicate names deliberately stay unresolved.
CREATE TRIGGER IF NOT EXISTS trg_support_cases_legacy_assignee_insert
AFTER INSERT ON support_cases
WHEN NEW.primary_assignee_staff_id IS NULL OR NEW.escalation_assignee_staff_id IS NULL
BEGIN
  UPDATE support_cases
  SET primary_assignee_staff_id = CASE
        WHEN NEW.primary_assignee_staff_id IS NOT NULL THEN NEW.primary_assignee_staff_id
        WHEN (SELECT COUNT(*) FROM staff_members sm WHERE sm.name = NEW.primary_assignee) = 1
          THEN (SELECT sm.id FROM staff_members sm WHERE sm.name = NEW.primary_assignee)
        ELSE NULL
      END,
      escalation_assignee_staff_id = CASE
        WHEN NEW.escalation_assignee_staff_id IS NOT NULL THEN NEW.escalation_assignee_staff_id
        WHEN (SELECT COUNT(*) FROM staff_members sm WHERE sm.name = NEW.escalation_assignee) = 1
          THEN (SELECT sm.id FROM staff_members sm WHERE sm.name = NEW.escalation_assignee)
        ELSE NULL
      END
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_support_cases_legacy_primary_assignee_update
AFTER UPDATE OF primary_assignee ON support_cases
WHEN NEW.primary_assignee IS NOT OLD.primary_assignee
  AND NEW.primary_assignee_staff_id IS OLD.primary_assignee_staff_id
BEGIN
  UPDATE support_cases
  SET primary_assignee_staff_id = CASE
        WHEN (SELECT COUNT(*) FROM staff_members sm WHERE sm.name = NEW.primary_assignee) = 1
          THEN (SELECT sm.id FROM staff_members sm WHERE sm.name = NEW.primary_assignee)
        ELSE NULL
      END
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_support_cases_legacy_escalation_assignee_update
AFTER UPDATE OF escalation_assignee ON support_cases
WHEN NEW.escalation_assignee IS NOT OLD.escalation_assignee
  AND NEW.escalation_assignee_staff_id IS OLD.escalation_assignee_staff_id
BEGIN
  UPDATE support_cases
  SET escalation_assignee_staff_id = CASE
        WHEN (SELECT COUNT(*) FROM staff_members sm WHERE sm.name = NEW.escalation_assignee) = 1
          THEN (SELECT sm.id FROM staff_members sm WHERE sm.name = NEW.escalation_assignee)
        ELSE NULL
      END
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_support_escalations_legacy_assignee_insert
AFTER INSERT ON support_escalations
WHEN NEW.assignee_staff_id IS NULL
BEGIN
  UPDATE support_escalations
  SET assignee_staff_id = CASE
        WHEN (SELECT COUNT(*) FROM staff_members sm WHERE sm.name = NEW.assignee) = 1
          THEN (SELECT sm.id FROM staff_members sm WHERE sm.name = NEW.assignee)
        ELSE NULL
      END
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_support_escalations_legacy_assignee_update
AFTER UPDATE OF assignee ON support_escalations
WHEN NEW.assignee IS NOT OLD.assignee
  AND NEW.assignee_staff_id IS OLD.assignee_staff_id
BEGIN
  UPDATE support_escalations
  SET assignee_staff_id = CASE
        WHEN (SELECT COUNT(*) FROM staff_members sm WHERE sm.name = NEW.assignee) = 1
          THEN (SELECT sm.id FROM staff_members sm WHERE sm.name = NEW.assignee)
        ELSE NULL
      END
  WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_support_cases_primary_assignee_staff
ON support_cases(primary_assignee_staff_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_cases_escalation_assignee_staff
ON support_cases(escalation_assignee_staff_id, status, updated_at DESC);
