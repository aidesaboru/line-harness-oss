-- Emoji reactions for internal staff chat messages.

ALTER TABLE support_internal_messages
  ADD COLUMN reactions TEXT NOT NULL DEFAULT '{}';

ALTER TABLE chat_internal_messages
  ADD COLUMN reactions TEXT NOT NULL DEFAULT '{}';
