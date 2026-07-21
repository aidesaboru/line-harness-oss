-- Repair support workflow states created before customer-reply and resolution
-- transitions were enforced atomically.

UPDATE support_cases
SET status = 'waiting_primary',
    updated_at = (
      SELECT MAX(ml.created_at)
      FROM messages_log ml
      WHERE ml.friend_id = support_cases.friend_id
        AND ml.direction = 'incoming'
        AND (ml.source IS NULL OR ml.source != 'postback')
        AND (ml.delivery_type IS NULL OR ml.delivery_type != 'test')
        AND ml.created_at > support_cases.updated_at
    )
WHERE status = 'customer_reply'
  AND (
    SELECT MAX(ml.created_at)
    FROM messages_log ml
    WHERE ml.friend_id = support_cases.friend_id
      AND ml.direction = 'incoming'
      AND (ml.source IS NULL OR ml.source != 'postback')
      AND (ml.delivery_type IS NULL OR ml.delivery_type != 'test')
  ) > COALESCE(
    (
      SELECT MAX(ml.created_at)
      FROM messages_log ml
      WHERE ml.friend_id = support_cases.friend_id
        AND ml.direction = 'outgoing'
        AND ml.source IN ('manual', 'scheduled_manual', 'line_official')
        AND (ml.delivery_type IS NULL OR ml.delivery_type != 'test')
    ),
    ''
  );

UPDATE support_escalations
SET status = 'closed',
    updated_at = COALESCE(
      (SELECT sc.closed_at FROM support_cases sc WHERE sc.id = support_escalations.case_id),
      (SELECT sc.updated_at FROM support_cases sc WHERE sc.id = support_escalations.case_id),
      updated_at
    )
WHERE status != 'closed'
  AND EXISTS (
    SELECT 1
    FROM support_cases sc
    WHERE sc.id = support_escalations.case_id
      AND sc.status = 'resolved'
  );
