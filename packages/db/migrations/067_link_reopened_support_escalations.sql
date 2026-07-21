-- Link a reopened request to its immutable completed source row.
-- Existing rows remain untouched and receive NULL for this optional column.

ALTER TABLE support_escalations
  ADD COLUMN reopened_from_id TEXT REFERENCES support_escalations(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_escalations_reopened_from
  ON support_escalations(reopened_from_id)
  WHERE reopened_from_id IS NOT NULL;
