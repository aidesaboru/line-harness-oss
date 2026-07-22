-- Register the environment owner as a reference-only staff identity.
-- This row satisfies audit-history foreign keys but can never authenticate.

INSERT OR IGNORE INTO staff_members (
  id,
  name,
  email,
  role,
  api_key,
  is_active,
  created_at,
  updated_at
) VALUES (
  'env-owner',
  '環境オーナー（参照専用）',
  NULL,
  'owner',
  'disabled_env_owner_' || lower(hex(randomblob(16))),
  0,
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'),
  strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')
);
