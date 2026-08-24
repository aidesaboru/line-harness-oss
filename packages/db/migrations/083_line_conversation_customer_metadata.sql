-- Group and room conversations are not individual friends, but they still need
-- customer identity fields for support operations. LINE's display_name remains untouched.
ALTER TABLE line_conversations
ADD COLUMN customer_metadata TEXT NOT NULL DEFAULT '{}'
CHECK (json_valid(customer_metadata));

CREATE INDEX IF NOT EXISTS idx_line_conversations_customer_number
ON line_conversations(json_extract(customer_metadata, '$.customerNumber'));
