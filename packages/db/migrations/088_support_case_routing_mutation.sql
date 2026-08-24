-- Identify one routing mutation across every statement in its D1 batch.
-- This lets concurrent admin updates guard escalation rows, audit events, and
-- notification outboxes without relying on millisecond timestamp uniqueness.
ALTER TABLE support_cases
ADD COLUMN routing_mutation_id TEXT;
