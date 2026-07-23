-- Generated from schema.sql + migrations by scripts/generate-bootstrap.mjs.
-- Do not edit manually. Run `pnpm --dir packages/db generate:bootstrap`.
CREATE TABLE account_health_logs (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  error_code      INTEGER,
  error_count     INTEGER NOT NULL DEFAULT 0,
  check_period    TEXT NOT NULL,
  risk_level      TEXT NOT NULL DEFAULT 'normal' CHECK (risk_level IN ('normal', 'warning', 'danger')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE account_migrations (
  id               TEXT PRIMARY KEY,
  from_account_id  TEXT NOT NULL,
  to_account_id    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  migrated_count   INTEGER NOT NULL DEFAULT 0,
  total_count      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  completed_at     TEXT
);

CREATE TABLE account_settings (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(line_account_id, key)
);

CREATE TABLE ad_conversion_logs (
  id                  TEXT PRIMARY KEY,
  ad_platform_id      TEXT NOT NULL,
  friend_id           TEXT NOT NULL,
  conversion_point_id TEXT,
  event_name          TEXT NOT NULL,
  click_id            TEXT,
  click_id_type       TEXT,
  status              TEXT DEFAULT 'pending',
  request_body        TEXT,
  response_body       TEXT,
  error_message       TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE ad_platforms (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  display_name TEXT,
  config       TEXT NOT NULL DEFAULT '{}',
  is_active    INTEGER DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE affiliate_clicks (
  id           TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliates (id) ON DELETE CASCADE,
  url          TEXT,
  ip_address   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE affiliates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  code            TEXT NOT NULL UNIQUE,
  commission_rate REAL NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE app_notification_inbox (
  id                TEXT PRIMARY KEY,
  notification_key  TEXT NOT NULL,
  recipient_staff_id TEXT NOT NULL,
  line_account_id   TEXT,
  kind              TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  href              TEXT NOT NULL,
  source_created_at TEXT NOT NULL,
  read_at           TEXT,
  snoozed_until     TEXT,
  dismissed_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(recipient_staff_id, notification_key)
);

CREATE TABLE auto_replies (
  id               TEXT PRIMARY KEY,
  keyword          TEXT NOT NULL,
  match_type       TEXT NOT NULL CHECK (match_type IN ('exact', 'contains')) DEFAULT 'exact',
  response_type    TEXT NOT NULL DEFAULT 'text',
  response_content TEXT NOT NULL,
  template_id      TEXT REFERENCES templates(id) ON DELETE SET NULL,
  line_account_id  TEXT DEFAULT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE automation_logs (
  id             TEXT PRIMARY KEY,
  automation_id  TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  friend_id      TEXT REFERENCES friends (id) ON DELETE SET NULL,
  event_data     TEXT,
  actions_result TEXT,
  status         TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'partial', 'failed')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE automations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  event_type  TEXT NOT NULL,
  conditions  TEXT NOT NULL DEFAULT '{}',
  actions     TEXT NOT NULL DEFAULT '[]',
  is_active   INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT);

CREATE TABLE booking_idempotency_keys (
  key              TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL,
  friend_id        TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response_body    TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at       TEXT NOT NULL                  -- UTC ISO8601
);

CREATE TABLE booking_reminders (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('day_before','hours_before')),
  scheduled_at  TEXT NOT NULL,                                -- UTC ISO8601
  sent_at       TEXT,                                         -- UTC ISO8601
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','failed_permanent','cancelled')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);

CREATE TABLE bookings (
  id                      TEXT PRIMARY KEY,
  line_account_id         TEXT NOT NULL,
  friend_id               TEXT NOT NULL,        -- friends.id
  staff_id                TEXT NOT NULL,
  menu_id                 TEXT NOT NULL,
  starts_at               TEXT NOT NULL,        -- UTC ISO8601 (Z)
  ends_at                 TEXT NOT NULL,        -- UTC ISO8601 (Z)
  block_ends_at           TEXT NOT NULL,        -- ends_at + buffer_after。衝突判定
  status                  TEXT NOT NULL CHECK (status IN ('requested','confirmed','rejected','expired','cancelled','completed','no_show')),
  customer_note           TEXT,
  internal_note           TEXT,
  price_at_booking        INTEGER NOT NULL,
  requested_at            TEXT NOT NULL,        -- UTC ISO8601
  decided_at              TEXT,                 -- UTC ISO8601
  decided_by_staff_id     TEXT,
  external_event_id       TEXT,                 -- Phase 3 余地 (Google Calendar)
  external_calendar_id    TEXT,                 -- Phase 3 余地
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (friend_id) REFERENCES friends(id),
  FOREIGN KEY (staff_id) REFERENCES staff(id),
  FOREIGN KEY (menu_id) REFERENCES menus(id)
);

CREATE TABLE broadcast_insights (
  id                  TEXT PRIMARY KEY,
  broadcast_id        TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  delivered           INTEGER,
  unique_impression   INTEGER,
  unique_click        INTEGER,
  unique_media_played INTEGER,
  open_rate           REAL,
  click_rate          REAL,
  raw_response        TEXT,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  retry_count         INTEGER NOT NULL DEFAULT 0,
  fetched_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE "broadcasts" (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  message_type       TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex')),
  message_content    TEXT NOT NULL,
  target_type        TEXT NOT NULL CHECK (target_type IN ('all', 'tag', 'segment', 'multi-account-dedup')) DEFAULT 'all',
  target_tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'sent')) DEFAULT 'draft',
  scheduled_at       TEXT,
  sent_at            TEXT,
  total_count        INTEGER NOT NULL DEFAULT 0,
  success_count      INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  line_account_id    TEXT,
  alt_text           TEXT,
  line_request_id    TEXT,
  aggregation_unit   TEXT,
  batch_offset       INTEGER NOT NULL DEFAULT 0,
  segment_conditions TEXT,
  account_ids        TEXT CHECK (account_ids IS NULL OR json_valid(account_ids)),
  dedup_priority     TEXT CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)),
  failed_account_ids TEXT CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids))
, dedup_progress TEXT, batch_lock_at TEXT);

CREATE TABLE calendar_bookings (
  id             TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL REFERENCES google_calendar_connections (id) ON DELETE CASCADE,
  friend_id      TEXT REFERENCES friends (id) ON DELETE SET NULL,
  event_id       TEXT,
  title          TEXT NOT NULL,
  start_at       TEXT NOT NULL,
  end_at         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'completed')),
  metadata       TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE chat_confirmation_events (
  id                    TEXT PRIMARY KEY,
  friend_id             TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  line_account_id       TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  staff_id              TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  staff_name            TEXT NOT NULL,
  confirmed_message_id  TEXT NOT NULL,
  confirmed_message_at  TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (friend_id, staff_id, confirmed_message_id)
);

CREATE TABLE chat_internal_messages (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  parent_id       TEXT REFERENCES chat_internal_messages(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  mentions        TEXT NOT NULL DEFAULT '[]',
  created_by      TEXT,
  created_by_name TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, reactions TEXT NOT NULL DEFAULT '{}');

CREATE TABLE chat_reminder_completion_events (
  id                    TEXT PRIMARY KEY,
  friend_id             TEXT NOT NULL REFERENCES friends(id) ON DELETE RESTRICT,
  line_account_id       TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  staff_id              TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  staff_name            TEXT NOT NULL,
  confirmed_message_id  TEXT NOT NULL,
  confirmed_message_at  TEXT NOT NULL,
  completed_at          TEXT NOT NULL
);

CREATE TABLE chat_typing_status (
  id              TEXT PRIMARY KEY,
  chat_id         TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  friend_id       TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  staff_id        TEXT NOT NULL,
  staff_name      TEXT NOT NULL,
  line_account_id TEXT,
  expires_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (chat_id, staff_id)
);

CREATE TABLE chats (
  id            TEXT PRIMARY KEY,
  friend_id     TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  operator_id   TEXT REFERENCES operators (id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'in_progress', 'resolved')),
  notes         TEXT,
  last_message_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT, is_long_term INTEGER NOT NULL DEFAULT 0 CHECK (is_long_term IN (0, 1)));

CREATE TABLE conversion_events (
  id                  TEXT PRIMARY KEY,
  conversion_point_id TEXT NOT NULL REFERENCES conversion_points (id) ON DELETE CASCADE,
  friend_id           TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  user_id             TEXT,
  affiliate_code      TEXT,
  metadata            TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE conversion_points (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  event_type TEXT NOT NULL,
  value      REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE entry_routes (
  id          TEXT PRIMARY KEY,
  ref_code    TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  redirect_url TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
, pool_id TEXT REFERENCES traffic_pools (id) ON DELETE SET NULL, intro_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, run_account_friend_add_scenarios INTEGER NOT NULL DEFAULT 1);

CREATE TABLE event_booking_idempotency_keys (
  key              TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL,
  friend_id        TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response_body    TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at       TEXT NOT NULL
);

CREATE TABLE event_booking_reminders (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('day_before','hours_before')),
  scheduled_at  TEXT NOT NULL,
  sent_at       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','failed_permanent','cancelled')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  FOREIGN KEY (booking_id) REFERENCES event_bookings(id)
);

CREATE TABLE event_bookings (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  event_id              TEXT NOT NULL,
  slot_id               TEXT NOT NULL,
  friend_id             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('requested','confirmed','rejected','cancelled','expired','no_show','attended')),
  customer_note         TEXT,
  internal_note         TEXT,
  requested_at          TEXT NOT NULL,
  decided_at            TEXT,
  decided_by_staff_id   TEXT,
  cancelled_at          TEXT,
  cancelled_by          TEXT CHECK (cancelled_by IN ('friend','admin','system')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), identity_key TEXT,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (slot_id) REFERENCES event_slots(id),
  FOREIGN KEY (friend_id) REFERENCES friends(id)
);

CREATE TABLE event_slots (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL,
  starts_at   TEXT NOT NULL,
  ends_at     TEXT NOT NULL,
  capacity    INTEGER,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE events (
  id                            TEXT PRIMARY KEY,
  line_account_id               TEXT NOT NULL,
  name                          TEXT NOT NULL,
  venue_name                    TEXT,
  venue_url                     TEXT,
  image_url                     TEXT,
  description                   TEXT,
  description_centered          INTEGER NOT NULL DEFAULT 0,
  max_bookings_per_friend       INTEGER,
  requires_approval             INTEGER NOT NULL DEFAULT 0,
  cancel_deadline_hours_before  INTEGER,
  reminder_day_before_enabled   INTEGER NOT NULL DEFAULT 1,
  reminder_hours_before         INTEGER,
  is_published                  INTEGER NOT NULL DEFAULT 0,
  folder_id                     TEXT,
  sort_order                    INTEGER NOT NULL DEFAULT 0,
  deleted_at                    TEXT,
  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), target_type TEXT NOT NULL DEFAULT 'single'
  CHECK (target_type IN ('single', 'multi-account-dedup')), account_ids TEXT
  CHECK (account_ids IS NULL OR json_valid(account_ids)), dedup_priority TEXT
  CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)), failed_account_ids TEXT
  CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids)), confirmation_message_extra TEXT, reminder_message_extra TEXT, og_title TEXT, og_description TEXT, og_image_url TEXT,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

CREATE TABLE form_opens (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  friend_id TEXT,
  friend_name TEXT,
  opened_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE form_submissions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends (id) ON DELETE SET NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE forms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  fields TEXT NOT NULL DEFAULT '[]',
  on_submit_tag_id TEXT REFERENCES tags (id) ON DELETE SET NULL,
  on_submit_scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  save_to_metadata INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  submit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, on_submit_message_type TEXT CHECK (on_submit_message_type IN ('text', 'flex')) DEFAULT NULL, on_submit_message_content TEXT DEFAULT NULL, on_submit_webhook_url TEXT, on_submit_webhook_headers TEXT, on_submit_webhook_fail_message TEXT, og_title TEXT, og_description TEXT, og_image_url TEXT);

CREATE TABLE friend_reminder_deliveries (
  id                TEXT PRIMARY KEY,
  friend_reminder_id TEXT NOT NULL REFERENCES friend_reminders (id) ON DELETE CASCADE,
  reminder_step_id  TEXT NOT NULL REFERENCES reminder_steps (id) ON DELETE CASCADE,
  delivered_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (friend_reminder_id, reminder_step_id)
);

CREATE TABLE friend_reminders (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  reminder_id     TEXT NOT NULL REFERENCES reminders (id) ON DELETE CASCADE,
  target_date     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE "friend_scenarios" (
  id                 TEXT PRIMARY KEY,
  friend_id          TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  scenario_id        TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  current_step_order INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'delivering')) DEFAULT 'active',
  started_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  next_delivery_at   TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE friend_scores (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  scoring_rule_id TEXT REFERENCES scoring_rules (id) ON DELETE SET NULL,
  score_change    INTEGER NOT NULL,
  reason          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE friend_tags (
  friend_id   TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (friend_id, tag_id)
);

CREATE TABLE friends (
  id               TEXT PRIMARY KEY,
  line_user_id     TEXT UNIQUE NOT NULL,
  display_name     TEXT,
  picture_url      TEXT,
  status_message   TEXT,
  is_following     INTEGER NOT NULL DEFAULT 1,
  user_id          TEXT,
  ig_igsid         TEXT,
  score            INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, ref_code TEXT, metadata TEXT NOT NULL DEFAULT '{}', line_account_id TEXT REFERENCES line_accounts(id), first_tracked_link_id TEXT REFERENCES tracked_links (id) ON DELETE SET NULL);

CREATE TABLE google_calendar_connections (
  id            TEXT PRIMARY KEY,
  calendar_id   TEXT NOT NULL,
  access_token  TEXT,
  refresh_token TEXT,
  api_key       TEXT,
  auth_type     TEXT NOT NULL DEFAULT 'api_key',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE incoming_webhooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'custom',
  secret      TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE internal_conversation_reads (
  conversation_id TEXT NOT NULL REFERENCES internal_conversations(id),
  staff_id         TEXT NOT NULL,
  last_read_at     TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY(conversation_id, staff_id)
);

CREATE TABLE internal_conversations (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('support', 'chat', 'channel', 'dm', 'group_dm', 'announcement')),
  source_id       TEXT,
  title           TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  archived_at     TEXT,
  UNIQUE(kind, source_id)
);

CREATE TABLE internal_message_bookmark_events (
  id                 TEXT PRIMARY KEY,
  source_type        TEXT NOT NULL CHECK (source_type IN ('support', 'chat')),
  source_message_id  TEXT NOT NULL,
  staff_id           TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  action             TEXT NOT NULL CHECK (action IN ('add', 'remove')),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE internal_message_events (
  id                 TEXT PRIMARY KEY,
  source_type        TEXT NOT NULL CHECK (source_type IN ('support', 'chat')),
  source_message_id  TEXT NOT NULL,
  version            INTEGER NOT NULL,
  action             TEXT NOT NULL CHECK (action IN ('edit', 'delete')),
  body               TEXT,
  mentions           TEXT NOT NULL DEFAULT '[]',
  mention_staff_ids  TEXT NOT NULL DEFAULT '[]',
  reason             TEXT,
  actor_id           TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  actor_name         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (source_type, source_message_id, version)
);

CREATE TABLE internal_message_mentions (
  source_type         TEXT NOT NULL CHECK (source_type IN ('support', 'chat', 'channel')),
  source_message_id   TEXT NOT NULL,
  staff_id            TEXT NOT NULL,
  staff_name_snapshot TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY(source_type, source_message_id, staff_id)
);

CREATE TABLE internal_task_assignees (
  task_id          TEXT NOT NULL REFERENCES internal_tasks(id) ON DELETE CASCADE,
  staff_id         TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  staff_name       TEXT NOT NULL,
  assigned_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  removed_at       TEXT,
  PRIMARY KEY (task_id, staff_id)
);

CREATE TABLE internal_task_comments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES internal_tasks(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_by  TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE internal_task_events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES internal_tasks(id) ON DELETE CASCADE,
  action      TEXT NOT NULL CHECK (action IN ('created', 'completed', 'reopened', 'updated')),
  metadata    TEXT NOT NULL DEFAULT '{}',
  actor_id    TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  actor_name  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE internal_tasks (
  id                 TEXT PRIMARY KEY,
  line_account_id    TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  source_type        TEXT NOT NULL CHECK (source_type IN ('support', 'chat')),
  source_id          TEXT NOT NULL,
  source_message_id  TEXT,
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  due_at              TEXT,
  created_by          TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  created_by_name     TEXT,
  completed_by       TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  completed_by_name  TEXT,
  completed_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE line_accounts (
  id                   TEXT PRIMARY KEY,
  channel_id           TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  channel_access_token TEXT NOT NULL,
  channel_secret       TEXT NOT NULL,
  is_active            INTEGER NOT NULL DEFAULT 1,
  country              TEXT,
  role                 TEXT,
  display_order        INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, login_channel_id TEXT, login_channel_secret TEXT, liff_id TEXT, token_expires_at TEXT, og_site_name TEXT, og_default_image_url TEXT, og_default_description TEXT);

CREATE TABLE line_conversation_messages (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES line_conversations (id) ON DELETE CASCADE,
  direction          TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  message_type       TEXT NOT NULL,
  content            TEXT NOT NULL,
  source             TEXT NOT NULL,
  line_account_id    TEXT,
  line_message_id    TEXT,
  webhook_event_id   TEXT,
  quote_token        TEXT,
  sender_user_id     TEXT,
  sender_name        TEXT,
  sender_picture_url TEXT,
  deleted_at         TEXT,
  deleted_reason     TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE line_conversations (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT,
  source_type     TEXT NOT NULL CHECK (source_type IN ('group', 'room')),
  source_id       TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  picture_url     TEXT,
  last_message_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE line_webhook_inbox (
  webhook_event_id TEXT PRIMARY KEY,
  line_account_id  TEXT,
  event_payload    TEXT NOT NULL CHECK (json_valid(event_payload)),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error_kind  TEXT,
  received_at      TEXT NOT NULL,
  processed_at     TEXT,
  next_attempt_at  TEXT,
  updated_at       TEXT NOT NULL
);

CREATE TABLE link_clicks (
  id TEXT PRIMARY KEY,
  tracked_link_id TEXT NOT NULL REFERENCES tracked_links (id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends (id) ON DELETE SET NULL,
  clicked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE menus (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  name                  TEXT NOT NULL,
  category_label        TEXT,
  description           TEXT,
  duration_minutes      INTEGER NOT NULL,
  buffer_after_minutes  INTEGER NOT NULL DEFAULT 0,
  base_price            INTEGER NOT NULL,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  is_active             INTEGER NOT NULL DEFAULT 1,
  deleted_at            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), auto_tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

CREATE TABLE message_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'flex')),
  message_content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages_log (
  id               TEXT PRIMARY KEY,
  friend_id        TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  direction        TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  message_type     TEXT NOT NULL,
  content          TEXT NOT NULL,
  broadcast_id     TEXT REFERENCES broadcasts (id) ON DELETE SET NULL,
  scenario_step_id TEXT REFERENCES scenario_steps (id) ON DELETE SET NULL,
  template_id_at_send TEXT,
  delivery_type    TEXT CHECK (delivery_type IN ('push', 'reply', 'test')),
  source           TEXT,
  line_account_id  TEXT,
  line_message_id  TEXT,
  webhook_event_id TEXT,
  quote_token      TEXT,
  quoted_message_id TEXT,
  mark_as_read_token TEXT,
  marked_as_read_at TEXT,
  marked_as_read_by TEXT,
  deleted_at       TEXT,
  deleted_reason   TEXT,
  sent_by_staff_id TEXT,
  sent_by_staff_name TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE notification_rules (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  conditions   TEXT NOT NULL DEFAULT '{}',
  channels     TEXT NOT NULL DEFAULT '["webhook"]',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  rule_id         TEXT REFERENCES notification_rules (id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  channel         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  metadata        TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE operators (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE outgoing_webhooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  event_types TEXT NOT NULL DEFAULT '[]',
  secret      TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE pool_accounts (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES traffic_pools(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pool_id, line_account_id)
);

CREATE TABLE ref_tracking (
  id              TEXT PRIMARY KEY,
  ref_code        TEXT NOT NULL,
  friend_id       TEXT REFERENCES friends (id) ON DELETE CASCADE,
  entry_route_id  TEXT REFERENCES entry_routes (id) ON DELETE SET NULL,
  source_url      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
, fbclid TEXT, gclid TEXT, twclid TEXT, ttclid TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, user_agent TEXT, ip_address TEXT);

CREATE TABLE reminder_steps (
  id              TEXT PRIMARY KEY,
  reminder_id     TEXT NOT NULL REFERENCES reminders (id) ON DELETE CASCADE,
  offset_minutes  INTEGER NOT NULL,
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex')),
  message_content TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE reminders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT);

CREATE TABLE rich_menu_areas (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL REFERENCES rich_menu_pages(id) ON DELETE CASCADE,
  bounds_x        INTEGER NOT NULL,
  bounds_y        INTEGER NOT NULL,
  bounds_width    INTEGER NOT NULL,
  bounds_height   INTEGER NOT NULL,
  action_type     TEXT NOT NULL CHECK (action_type IN ('uri','message','postback','richmenuswitch')),
  action_data     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE rich_menu_groups (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  chat_bar_text      TEXT NOT NULL,
  size               TEXT NOT NULL CHECK (size IN ('large','compact')),
  default_page_id    TEXT,
  is_default_for_all INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  publishing_at      TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE rich_menu_pages (
  id                 TEXT PRIMARY KEY,
  group_id           TEXT NOT NULL REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  order_index        INTEGER NOT NULL,
  name               TEXT NOT NULL,
  alias_id           TEXT NOT NULL,
  line_richmenu_id   TEXT,
  image_r2_key       TEXT,
  image_content_type TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (group_id, order_index)
);

CREATE TABLE scenario_steps (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  step_order      INTEGER NOT NULL,
  delay_minutes   INTEGER NOT NULL DEFAULT 0,
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex')),
  message_content TEXT NOT NULL,
  offset_days     INTEGER,
  offset_minutes  INTEGER,
  delivery_time   TEXT,
  template_id     TEXT REFERENCES templates(id) ON DELETE SET NULL,
  on_reach_tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), condition_type TEXT, condition_value TEXT, next_step_on_false INTEGER,
  UNIQUE (scenario_id, step_order)
);

CREATE TABLE scenarios (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('friend_add', 'tag_added', 'manual')),
  trigger_tag_id  TEXT REFERENCES tags (id) ON DELETE SET NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  delivery_mode   TEXT NOT NULL DEFAULT 'relative' CHECK (delivery_mode IN ('relative', 'elapsed', 'absolute_time')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT);

CREATE TABLE scheduled_chat_messages (
  id                  TEXT PRIMARY KEY,
  chat_id             TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  friend_id           TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  line_account_id     TEXT,
  messages_json       TEXT NOT NULL,
  support_case_id     TEXT,
  scheduled_at        TEXT NOT NULL,
  next_attempt_at     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'failed_permanent', 'cancelled')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_by          TEXT,
  created_by_name     TEXT,
  sent_at             TEXT,
  cancelled_at        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE scoring_rules (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  score_value INTEGER NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE staff (
  id                       TEXT PRIMARY KEY,
  line_account_id          TEXT NOT NULL,
  name                     TEXT NOT NULL,
  display_name             TEXT NOT NULL,
  role                     TEXT,
  profile_image_url        TEXT,
  bio                      TEXT,
  sort_order               INTEGER NOT NULL DEFAULT 0,
  is_designation_optional  INTEGER NOT NULL DEFAULT 0,
  is_active                INTEGER NOT NULL DEFAULT 1,
  deleted_at               TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);

CREATE TABLE "staff_members" (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff', 'secondary')),
  api_key    TEXT UNIQUE NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE staff_menus (
  staff_id                  TEXT NOT NULL,
  menu_id                   TEXT NOT NULL,
  is_offered                INTEGER NOT NULL DEFAULT 1,
  override_duration_minutes INTEGER,
  override_price            INTEGER,
  PRIMARY KEY (staff_id, menu_id),
  FOREIGN KEY (staff_id) REFERENCES staff(id),
  FOREIGN KEY (menu_id) REFERENCES menus(id)
);

CREATE TABLE staff_presence (
  staff_id      TEXT PRIMARY KEY,
  staff_name    TEXT NOT NULL,
  staff_role    TEXT NOT NULL DEFAULT 'staff' CHECK (staff_role IN ('owner', 'admin', 'staff', 'secondary')),
  last_seen_at  TEXT NOT NULL,
  last_login_at TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE staff_shifts (
  id          TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL,
  work_date   TEXT NOT NULL,    -- YYYY-MM-DD (JST)
  start_time  TEXT NOT NULL,    -- HH:MM (JST)
  end_time    TEXT NOT NULL,    -- HH:MM (JST)
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (staff_id, work_date),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);

CREATE TABLE stripe_events (
  id               TEXT PRIMARY KEY,
  stripe_event_id  TEXT NOT NULL UNIQUE,
  event_type       TEXT NOT NULL,
  friend_id        TEXT REFERENCES friends (id) ON DELETE SET NULL,
  amount           REAL,
  currency         TEXT,
  metadata         TEXT,
  processed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE support_case_attachments (
  id               TEXT PRIMARY KEY,
  case_id          TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  line_account_id  TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  r2_key           TEXT NOT NULL,
  file_name        TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  created_by_name  TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE support_case_events (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  actor_id        TEXT,
  actor_name      TEXT,
  body            TEXT NOT NULL DEFAULT '',
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE support_case_followup_reminder_events (
  id            TEXT PRIMARY KEY,
  reminder_id   TEXT NOT NULL REFERENCES support_case_followup_reminders(id) ON DELETE RESTRICT,
  case_id       TEXT NOT NULL REFERENCES support_cases(id) ON DELETE RESTRICT,
  action        TEXT NOT NULL CHECK (action IN ('configured', 'reconfigured', 'confirmed', 'completed', 'disabled')),
  metadata      TEXT NOT NULL DEFAULT '{}',
  actor_id      TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  actor_name    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE support_case_followup_reminders (
  id                  TEXT PRIMARY KEY,
  case_id             TEXT NOT NULL UNIQUE REFERENCES support_cases(id) ON DELETE RESTRICT,
  line_account_id     TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  owner_staff_id      TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  owner_name          TEXT NOT NULL,
  interval_days       INTEGER NOT NULL CHECK (interval_days BETWEEN 1 AND 365),
  next_due_at         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'disabled')),
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_confirmed_at   TEXT,
  last_confirmed_by   TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  last_confirmed_name TEXT,
  created_by          TEXT REFERENCES staff_members(id) ON DELETE SET NULL,
  created_by_name     TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE "support_cases" (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  friend_id             TEXT REFERENCES friends(id) ON DELETE SET NULL,
  title                 TEXT NOT NULL,
  category              TEXT NOT NULL DEFAULT 'other',
  priority              TEXT NOT NULL DEFAULT 'medium'
                         CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status                TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN (
                           'open',
                           'in_progress',
                           'waiting_primary',
                           'escalated',
                           'waiting_secondary',
                           'secondary_answered',
                           'customer_reply',
                           'on_hold',
                           'resolved',
                           'reopened'
                         )),
  primary_assignee      TEXT,
  escalation_assignee   TEXT,
  escalation_level      TEXT NOT NULL DEFAULT 'L1'
                         CHECK (escalation_level IN ('L1', 'L2', 'L3')),
  due_at                TEXT,
  next_check_at         TEXT,
  customer_number       TEXT,
  company_name          TEXT,
  contact_name          TEXT,
  store_name            TEXT,
  contract_type         TEXT,
  customer_summary      TEXT NOT NULL DEFAULT '',
  internal_note         TEXT NOT NULL DEFAULT '',
  customer_reply_draft  TEXT NOT NULL DEFAULT '',
  resolution_note       TEXT NOT NULL DEFAULT '',
  manual_ids            TEXT NOT NULL DEFAULT '[]',
  created_by            TEXT,
  updated_by            TEXT,
  closed_at             TEXT,
  reopened_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE support_escalations (
  id                  TEXT PRIMARY KEY,
  case_id             TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  line_account_id     TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  assignee            TEXT NOT NULL,
  level               TEXT NOT NULL DEFAULT 'L2' CHECK (level IN ('L2', 'L3')),
  status              TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'answered', 'needs_info', 'transferred', 'expert_check', 'closed')),
  question            TEXT NOT NULL,
  answer              TEXT NOT NULL DEFAULT '',
  due_at              TEXT,
  answered_at         TEXT,
  created_by          TEXT,
  updated_by          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, reopened_from_id TEXT REFERENCES support_escalations(id), assignee_staff_id TEXT REFERENCES staff_members(id) ON DELETE SET NULL);

CREATE TABLE support_internal_messages (
  id               TEXT PRIMARY KEY,
  case_id          TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  line_account_id  TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  parent_id        TEXT REFERENCES support_internal_messages(id) ON DELETE CASCADE,
  body             TEXT NOT NULL,
  mentions         TEXT NOT NULL DEFAULT '[]',
  created_by       TEXT,
  created_by_name  TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, reactions TEXT NOT NULL DEFAULT '{}');

CREATE TABLE support_knowledge_imports (
  id                  TEXT PRIMARY KEY,
  line_account_id     TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  source              TEXT NOT NULL DEFAULT 'slack' CHECK (source IN ('slack')),
  source_channel_id   TEXT NOT NULL,
  source_channel_name TEXT,
  source_message_ts   TEXT NOT NULL,
  source_thread_ts    TEXT NOT NULL,
  source_permalink    TEXT,
  source_author       TEXT,
  source_posted_at    TEXT,
  title               TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'other',
  question            TEXT NOT NULL DEFAULT '',
  answer              TEXT NOT NULL DEFAULT '',
  body                TEXT NOT NULL DEFAULT '',
  keywords            TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'dismissed')),
  manual_id           TEXT REFERENCES support_manuals(id) ON DELETE SET NULL,
  imported_by         TEXT,
  reviewed_by         TEXT,
  imported_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  reviewed_at         TEXT,
  published_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(source_channel_id, source_thread_ts)
);

CREATE TABLE support_knowledge_source_snapshots (
  id                  TEXT PRIMARY KEY,
  knowledge_import_id TEXT NOT NULL REFERENCES support_knowledge_imports(id) ON DELETE RESTRICT,
  line_account_id     TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  source_channel_id   TEXT NOT NULL,
  source_thread_ts    TEXT NOT NULL,
  raw_payload         TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  is_reconstructed    INTEGER NOT NULL DEFAULT 0,
  captured_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(knowledge_import_id, content_hash)
);

CREATE TABLE support_manual_revisions (
  id              TEXT PRIMARY KEY,
  manual_id       TEXT NOT NULL REFERENCES support_manuals(id) ON DELETE RESTRICT,
  line_account_id TEXT,
  change_type     TEXT NOT NULL,
  snapshot        TEXT NOT NULL,
  actor_id        TEXT,
  actor_name      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE support_manual_usage_events (
  id              TEXT PRIMARY KEY,
  manual_id       TEXT NOT NULL REFERENCES support_manuals(id) ON DELETE RESTRICT,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE RESTRICT,
  action          TEXT NOT NULL CHECK (action IN ('copied', 'helpful', 'needs_improvement')),
  actor_id        TEXT,
  actor_name      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE support_manuals (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'basic',
  body            TEXT NOT NULL DEFAULT '',
  url             TEXT,
  keywords        TEXT NOT NULL DEFAULT '',
  owner           TEXT,
  approved_by     TEXT,
  revised_at      TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT,
  updated_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, knowledge_question TEXT NOT NULL DEFAULT '', knowledge_resolution TEXT NOT NULL DEFAULT '', knowledge_procedure TEXT NOT NULL DEFAULT '', knowledge_applicability TEXT NOT NULL DEFAULT '', knowledge_cautions TEXT NOT NULL DEFAULT '', knowledge_source_body TEXT NOT NULL DEFAULT '', knowledge_status TEXT NOT NULL DEFAULT 'needs_review', knowledge_quality_score INTEGER NOT NULL DEFAULT 0, knowledge_review_note TEXT NOT NULL DEFAULT '', knowledge_use_count INTEGER NOT NULL DEFAULT 0, knowledge_last_used_at TEXT, knowledge_helpful_count INTEGER NOT NULL DEFAULT 0, knowledge_needs_improvement_count INTEGER NOT NULL DEFAULT 0);

CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  color      TEXT NOT NULL DEFAULT '#3B82F6',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'general',
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'carousel')),
  message_content TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE tracked_links (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  original_url TEXT NOT NULL,
  tag_id TEXT REFERENCES tags (id) ON DELETE SET NULL,
  scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  click_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, intro_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, reward_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, og_title TEXT, og_description TEXT, og_image_url TEXT);

CREATE TABLE traffic_pools (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  active_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE update_history (
  id                          TEXT PRIMARY KEY,
  started_at                  INTEGER NOT NULL,
  completed_at                INTEGER,
  from_version                TEXT NOT NULL,
  to_version                  TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('running','success','failed','rolled_back')),
  snapshot_worker_url         TEXT,
  snapshot_admin_deployment   TEXT,
  snapshot_liff_deployment    TEXT,
  events_jsonl                TEXT NOT NULL DEFAULT '',
  error                       TEXT,
  rollback_of                 TEXT REFERENCES update_history(id),
  rollback_expires_at         INTEGER
);

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT,
  phone        TEXT,
  external_id  TEXT,
  display_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE TABLE web_push_deliveries (
  id                TEXT PRIMARY KEY,
  subscription_id   TEXT NOT NULL REFERENCES web_push_subscriptions(id) ON DELETE CASCADE,
  notification_id   TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  error             TEXT,
  sent_at           TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(subscription_id, notification_id)
);

CREATE TABLE web_push_subscriptions (
  id                TEXT PRIMARY KEY,
  staff_id          TEXT NOT NULL,
  staff_name        TEXT NOT NULL,
  staff_role        TEXT NOT NULL DEFAULT 'staff',
  endpoint          TEXT NOT NULL UNIQUE,
  p256dh            TEXT NOT NULL,
  auth              TEXT NOT NULL,
  user_agent        TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  notify_urgent     INTEGER NOT NULL DEFAULT 1,
  notify_secondary  INTEGER NOT NULL DEFAULT 1,
  notify_mentions   INTEGER NOT NULL DEFAULT 1,
  last_error        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  last_seen_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX idx_ad_conversion_logs_friend ON ad_conversion_logs (friend_id);

CREATE INDEX idx_ad_conversion_logs_platform ON ad_conversion_logs (ad_platform_id);

CREATE INDEX idx_ad_conversion_logs_status ON ad_conversion_logs (status);

CREATE INDEX idx_affiliate_clicks_affiliate ON affiliate_clicks (affiliate_id);

CREATE INDEX idx_app_notification_inbox_account
  ON app_notification_inbox(recipient_staff_id, line_account_id, source_created_at DESC);

CREATE INDEX idx_app_notification_inbox_recipient
  ON app_notification_inbox(recipient_staff_id, dismissed_at, source_created_at DESC);

CREATE INDEX idx_auto_replies_template_id ON auto_replies(template_id);

CREATE INDEX idx_automation_logs_automation ON automation_logs (automation_id);

CREATE INDEX idx_automations_active ON automations (is_active);

CREATE INDEX idx_automations_event ON automations (event_type);

CREATE INDEX idx_bookings_account_status_starts ON bookings (line_account_id, status, starts_at);

CREATE INDEX idx_bookings_friend_starts ON bookings (friend_id, starts_at DESC);

CREATE INDEX idx_bookings_staff_overlap ON bookings (staff_id, status, starts_at, block_ends_at);

CREATE INDEX idx_broadcast_insights_broadcast_id ON broadcast_insights(broadcast_id);

CREATE INDEX idx_broadcast_insights_status ON broadcast_insights(status);

CREATE INDEX idx_broadcasts_status ON broadcasts (status);

CREATE INDEX idx_calendar_bookings_friend ON calendar_bookings (friend_id);

CREATE INDEX idx_calendar_bookings_start ON calendar_bookings (start_at);

CREATE INDEX idx_chat_confirmation_events_staff
  ON chat_confirmation_events(staff_id, friend_id, confirmed_message_at DESC, confirmed_message_id DESC);

CREATE INDEX idx_chat_internal_messages_account
  ON chat_internal_messages(line_account_id, created_at);

CREATE INDEX idx_chat_internal_messages_friend
  ON chat_internal_messages(friend_id, created_at);

CREATE INDEX idx_chat_internal_messages_parent
  ON chat_internal_messages(parent_id, created_at);

CREATE INDEX idx_chat_reminder_completion_friend_staff
  ON chat_reminder_completion_events(friend_id, staff_id, completed_at DESC, id DESC);

CREATE INDEX idx_chat_typing_status_chat ON chat_typing_status (chat_id, expires_at);

CREATE INDEX idx_chat_typing_status_friend ON chat_typing_status (friend_id, expires_at);

CREATE INDEX idx_chats_friend ON chats (friend_id);

CREATE INDEX idx_chats_long_term
  ON chats (is_long_term, last_message_at);

CREATE INDEX idx_chats_operator ON chats (operator_id);

CREATE INDEX idx_chats_status ON chats (status);

CREATE INDEX idx_conversion_events_affiliate ON conversion_events (affiliate_code);

CREATE INDEX idx_conversion_events_friend ON conversion_events (friend_id);

CREATE INDEX idx_conversion_events_point ON conversion_events (conversion_point_id);

CREATE INDEX idx_entry_routes_pool ON entry_routes (pool_id);

CREATE INDEX idx_entry_routes_ref ON entry_routes (ref_code);

CREATE INDEX idx_event_booking_idempotency_expires ON event_booking_idempotency_keys (expires_at);

CREATE INDEX idx_event_booking_reminders_status_scheduled ON event_booking_reminders (status, scheduled_at);

CREATE INDEX idx_event_bookings_account_status_event ON event_bookings (line_account_id, status, event_id);

CREATE INDEX idx_event_bookings_friend_requested ON event_bookings (friend_id, requested_at DESC);

CREATE INDEX idx_event_bookings_identity_status
  ON event_bookings (event_id, identity_key, status);

CREATE INDEX idx_event_bookings_slot_status ON event_bookings (slot_id, status);

CREATE INDEX idx_event_slots_event_starts ON event_slots (event_id, starts_at);

CREATE INDEX idx_events_account_published_sort ON events (line_account_id, is_published, sort_order);

CREATE INDEX idx_form_opens_form ON form_opens (form_id, opened_at);

CREATE INDEX idx_form_submissions_form ON form_submissions (form_id);

CREATE INDEX idx_form_submissions_friend ON form_submissions (friend_id);

CREATE INDEX idx_friend_reminders_friend ON friend_reminders (friend_id);

CREATE INDEX idx_friend_reminders_status ON friend_reminders (status);

CREATE INDEX idx_friend_scenarios_friend_id ON friend_scenarios (friend_id);

CREATE INDEX idx_friend_scenarios_next_delivery_at ON friend_scenarios (next_delivery_at);

CREATE INDEX idx_friend_scenarios_status ON friend_scenarios (status);

CREATE UNIQUE INDEX idx_friend_scenarios_unique ON friend_scenarios (friend_id, scenario_id) WHERE status != 'completed';

CREATE INDEX idx_friend_scores_created ON friend_scores (created_at);

CREATE INDEX idx_friend_scores_friend ON friend_scores (friend_id);

CREATE INDEX idx_friend_tags_tag_id ON friend_tags (tag_id);

CREATE INDEX idx_friends_ig_igsid ON friends (ig_igsid);

CREATE INDEX idx_friends_line_user_id ON friends (line_user_id);

CREATE INDEX idx_friends_user_id ON friends (user_id);

CREATE INDEX idx_health_logs_account ON account_health_logs (line_account_id);

CREATE INDEX idx_idempotency_expires ON booking_idempotency_keys (expires_at);

CREATE INDEX idx_internal_conversation_reads_staff
  ON internal_conversation_reads(staff_id, updated_at DESC);

CREATE INDEX idx_internal_conversations_account_updated
  ON internal_conversations(line_account_id, updated_at DESC);

CREATE INDEX idx_internal_conversations_kind_source
  ON internal_conversations(kind, source_id);

CREATE INDEX idx_internal_message_bookmark_events_message
  ON internal_message_bookmark_events(source_type, source_message_id, staff_id, created_at DESC);

CREATE INDEX idx_internal_message_bookmark_events_staff
  ON internal_message_bookmark_events(staff_id, created_at DESC);

CREATE INDEX idx_internal_message_events_source
  ON internal_message_events(source_type, source_message_id, version DESC);

CREATE INDEX idx_internal_message_mentions_staff
  ON internal_message_mentions(staff_id, created_at DESC);

CREATE INDEX idx_internal_task_assignees_staff
  ON internal_task_assignees(staff_id, removed_at, assigned_at DESC);

CREATE INDEX idx_internal_task_comments_task
  ON internal_task_comments(task_id, created_at, id);

CREATE INDEX idx_internal_task_events_task
  ON internal_task_events(task_id, created_at);

CREATE INDEX idx_internal_tasks_account_status
  ON internal_tasks(line_account_id, status, updated_at DESC);

CREATE INDEX idx_internal_tasks_source
  ON internal_tasks(source_type, source_id, created_at DESC);

CREATE INDEX idx_line_accounts_display_order
  ON line_accounts (display_order, created_at);

CREATE INDEX idx_line_conversation_messages_conversation_created
ON line_conversation_messages (conversation_id, created_at, id);

CREATE INDEX idx_line_conversation_messages_line_message
ON line_conversation_messages (line_message_id);

CREATE UNIQUE INDEX idx_line_conversation_messages_webhook_event
ON line_conversation_messages (webhook_event_id)
WHERE webhook_event_id IS NOT NULL;

CREATE INDEX idx_line_conversations_account_last_message
ON line_conversations (line_account_id, last_message_at);

CREATE UNIQUE INDEX idx_line_conversations_source
ON line_conversations (COALESCE(line_account_id, ''), source_type, source_id);

CREATE INDEX idx_line_webhook_inbox_status_attempt
ON line_webhook_inbox (status, next_attempt_at, updated_at);

CREATE INDEX idx_link_clicks_friend ON link_clicks (friend_id);

CREATE INDEX idx_link_clicks_link ON link_clicks (tracked_link_id);

CREATE INDEX idx_menus_account_sort ON menus (line_account_id, sort_order);

CREATE INDEX idx_messages_log_broadcast_id ON messages_log(broadcast_id);

CREATE INDEX idx_messages_log_created_at ON messages_log (created_at);

CREATE INDEX idx_messages_log_friend_direction_created ON messages_log (friend_id, direction, created_at);

CREATE INDEX idx_messages_log_friend_id ON messages_log (friend_id);

CREATE INDEX idx_messages_log_friend_source ON messages_log (friend_id, source);

CREATE INDEX idx_messages_log_line_message_id ON messages_log (line_message_id);

CREATE INDEX idx_messages_log_quoted_message_id ON messages_log (quoted_message_id);

CREATE UNIQUE INDEX idx_messages_log_webhook_event_id ON messages_log (webhook_event_id) WHERE webhook_event_id IS NOT NULL;

CREATE INDEX idx_notifications_created ON notifications (created_at);

CREATE INDEX idx_notifications_status ON notifications (status);

CREATE INDEX idx_ref_tracking_friend ON ref_tracking (friend_id);

CREATE INDEX idx_ref_tracking_ref    ON ref_tracking (ref_code);

CREATE INDEX idx_reminder_steps_reminder ON reminder_steps (reminder_id);

CREATE INDEX idx_reminders_status_scheduled ON booking_reminders (status, scheduled_at);

CREATE INDEX idx_rich_menu_areas_page     ON rich_menu_areas(page_id);

CREATE INDEX idx_rich_menu_groups_account ON rich_menu_groups(account_id, status);

CREATE INDEX idx_rich_menu_pages_group    ON rich_menu_pages(group_id, order_index);

CREATE INDEX idx_scenario_steps_scenario_id ON scenario_steps (scenario_id);

CREATE INDEX idx_scheduled_chat_messages_chat
  ON scheduled_chat_messages (chat_id, scheduled_at DESC);

CREATE INDEX idx_scheduled_chat_messages_due
  ON scheduled_chat_messages (status, next_attempt_at);

CREATE INDEX idx_shifts_staff_date ON staff_shifts (staff_id, work_date);

CREATE INDEX idx_staff_account_sort ON staff (line_account_id, sort_order);

CREATE UNIQUE INDEX idx_staff_members_api_key ON staff_members(api_key);

CREATE INDEX idx_staff_members_role ON staff_members(role);

CREATE INDEX idx_staff_presence_last_seen
  ON staff_presence(last_seen_at);

CREATE INDEX idx_stripe_events_friend ON stripe_events (friend_id);

CREATE INDEX idx_stripe_events_type ON stripe_events (event_type);

CREATE INDEX idx_support_case_attachments_case
  ON support_case_attachments(case_id, created_at);

CREATE INDEX idx_support_case_events_case
  ON support_case_events(case_id, created_at);

CREATE INDEX idx_support_case_followup_account
  ON support_case_followup_reminders(line_account_id, status, updated_at DESC);

CREATE INDEX idx_support_case_followup_due
  ON support_case_followup_reminders(owner_staff_id, status, next_due_at);

CREATE INDEX idx_support_case_followup_events_reminder
  ON support_case_followup_reminder_events(reminder_id, created_at DESC);

CREATE INDEX idx_support_cases_account_due_status
  ON support_cases(line_account_id, due_at, status);

CREATE INDEX idx_support_cases_account_status
  ON support_cases(line_account_id, status, updated_at);

CREATE INDEX idx_support_cases_assignee
  ON support_cases(primary_assignee, escalation_assignee, status);

CREATE INDEX idx_support_cases_due
  ON support_cases(due_at, status);

CREATE INDEX idx_support_cases_friend
  ON support_cases(friend_id, updated_at);

CREATE INDEX idx_support_escalations_account_status_due
  ON support_escalations(line_account_id, status, due_at);

CREATE INDEX idx_support_escalations_assignee
  ON support_escalations(assignee, status, due_at);

CREATE INDEX idx_support_escalations_assignee_staff
  ON support_escalations(assignee_staff_id, status, updated_at DESC);

CREATE INDEX idx_support_escalations_case
  ON support_escalations(case_id, created_at);

CREATE UNIQUE INDEX idx_support_escalations_reopened_from
  ON support_escalations(reopened_from_id)
  WHERE reopened_from_id IS NOT NULL;

CREATE INDEX idx_support_internal_messages_account
  ON support_internal_messages(line_account_id, created_at);

CREATE INDEX idx_support_internal_messages_case
  ON support_internal_messages(case_id, created_at);

CREATE INDEX idx_support_internal_messages_parent
  ON support_internal_messages(parent_id, created_at);

CREATE INDEX idx_support_knowledge_imports_account_status
  ON support_knowledge_imports(line_account_id, status, updated_at);

CREATE INDEX idx_support_knowledge_imports_source
  ON support_knowledge_imports(source_channel_id, source_thread_ts);

CREATE INDEX idx_support_knowledge_source_snapshots_import
  ON support_knowledge_source_snapshots(knowledge_import_id, captured_at);

CREATE INDEX idx_support_manual_revisions_manual_created
  ON support_manual_revisions(manual_id, created_at);

CREATE INDEX idx_support_manual_usage_events_manual_created
  ON support_manual_usage_events(manual_id, created_at);

CREATE INDEX idx_support_manuals_account_category
  ON support_manuals(line_account_id, category, is_active);

CREATE INDEX idx_support_manuals_account_knowledge_status
  ON support_manuals(line_account_id, knowledge_status, is_active, revised_at);

CREATE INDEX idx_templates_category ON templates (category);

CREATE INDEX idx_update_history_started ON update_history(started_at DESC);

CREATE INDEX idx_users_email ON users (email);

CREATE INDEX idx_users_external_id ON users (external_id);

CREATE INDEX idx_users_phone ON users (phone);

CREATE INDEX idx_web_push_deliveries_notification
  ON web_push_deliveries(notification_id);

CREATE INDEX idx_web_push_deliveries_subscription
  ON web_push_deliveries(subscription_id, created_at);

CREATE INDEX idx_web_push_subscriptions_staff
  ON web_push_subscriptions(staff_id, is_active, last_seen_at);

CREATE TRIGGER prevent_support_knowledge_imports_delete
BEFORE DELETE ON support_knowledge_imports
BEGIN
  SELECT RAISE(ABORT, 'support_knowledge_imports cannot be deleted');
END;

CREATE TRIGGER prevent_support_knowledge_source_snapshots_delete
BEFORE DELETE ON support_knowledge_source_snapshots
BEGIN
  SELECT RAISE(ABORT, 'support_knowledge_source_snapshots are append-only');
END;

CREATE TRIGGER prevent_support_knowledge_source_snapshots_update
BEFORE UPDATE ON support_knowledge_source_snapshots
BEGIN
  SELECT RAISE(ABORT, 'support_knowledge_source_snapshots are append-only');
END;

CREATE TRIGGER prevent_support_manual_revisions_delete
BEFORE DELETE ON support_manual_revisions
BEGIN
  SELECT RAISE(ABORT, 'support_manual_revisions are append-only');
END;

CREATE TRIGGER prevent_support_manual_revisions_update
BEFORE UPDATE ON support_manual_revisions
BEGIN
  SELECT RAISE(ABORT, 'support_manual_revisions are append-only');
END;

CREATE TRIGGER prevent_support_manual_usage_events_delete
BEFORE DELETE ON support_manual_usage_events
BEGIN
  SELECT RAISE(ABORT, 'support_manual_usage_events are append-only');
END;

CREATE TRIGGER prevent_support_manual_usage_events_update
BEFORE UPDATE ON support_manual_usage_events
BEGIN
  SELECT RAISE(ABORT, 'support_manual_usage_events are append-only');
END;

CREATE TRIGGER prevent_support_manuals_delete
BEFORE DELETE ON support_manuals
BEGIN
  SELECT RAISE(ABORT, 'support_manuals cannot be deleted; set is_active = 0 instead');
END;

CREATE TRIGGER protect_chat_confirmation_events_delete
BEFORE DELETE ON chat_confirmation_events
BEGIN
  SELECT RAISE(ABORT, 'chat confirmation events cannot be deleted');
END;

CREATE TRIGGER protect_chat_confirmation_events_update
BEFORE UPDATE ON chat_confirmation_events
BEGIN
  SELECT RAISE(ABORT, 'chat confirmation events cannot be updated');
END;

CREATE TRIGGER protect_chat_internal_messages_delete
BEFORE DELETE ON chat_internal_messages
BEGIN
  SELECT RAISE(ABORT, 'chat_internal_messages history is protected');
END;

CREATE TRIGGER protect_chat_reminder_completion_events_delete
BEFORE DELETE ON chat_reminder_completion_events
BEGIN
  SELECT RAISE(ABORT, 'chat reminder completion events cannot be deleted');
END;

CREATE TRIGGER protect_chat_reminder_completion_events_update
BEFORE UPDATE ON chat_reminder_completion_events
BEGIN
  SELECT RAISE(ABORT, 'chat reminder completion events cannot be updated');
END;

CREATE TRIGGER protect_chats_delete
BEFORE DELETE ON chats
BEGIN
  SELECT RAISE(ABORT, 'chats history is protected');
END;

CREATE TRIGGER protect_friends_delete
BEFORE DELETE ON friends
BEGIN
  SELECT RAISE(ABORT, 'friends history is protected');
END;

CREATE TRIGGER protect_internal_message_bookmark_events_delete
BEFORE DELETE ON internal_message_bookmark_events
BEGIN
  SELECT RAISE(ABORT, 'bookmark events cannot be deleted');
END;

CREATE TRIGGER protect_internal_message_bookmark_events_update
BEFORE UPDATE ON internal_message_bookmark_events
BEGIN
  SELECT RAISE(ABORT, 'bookmark events cannot be updated');
END;

CREATE TRIGGER protect_internal_message_events_delete
BEFORE DELETE ON internal_message_events
BEGIN
  SELECT RAISE(ABORT, 'internal message events cannot be deleted');
END;

CREATE TRIGGER protect_internal_message_events_update
BEFORE UPDATE ON internal_message_events
BEGIN
  SELECT RAISE(ABORT, 'internal message events cannot be updated');
END;

CREATE TRIGGER protect_internal_task_comments_delete
BEFORE DELETE ON internal_task_comments
BEGIN
  SELECT RAISE(ABORT, 'internal task comments cannot be deleted');
END;

CREATE TRIGGER protect_internal_task_comments_update
BEFORE UPDATE ON internal_task_comments
BEGIN
  SELECT RAISE(ABORT, 'internal task comments cannot be updated');
END;

CREATE TRIGGER protect_internal_task_events_delete
BEFORE DELETE ON internal_task_events
BEGIN
  SELECT RAISE(ABORT, 'internal task events cannot be deleted');
END;

CREATE TRIGGER protect_internal_task_events_update
BEFORE UPDATE ON internal_task_events
BEGIN
  SELECT RAISE(ABORT, 'internal task events cannot be updated');
END;

CREATE TRIGGER protect_internal_tasks_delete
BEFORE DELETE ON internal_tasks
BEGIN
  SELECT RAISE(ABORT, 'internal tasks cannot be deleted');
END;

CREATE TRIGGER protect_line_accounts_delete
BEFORE DELETE ON line_accounts
BEGIN
  SELECT RAISE(ABORT, 'line_accounts history is protected');
END;

CREATE TRIGGER protect_line_conversation_messages_delete
BEFORE DELETE ON line_conversation_messages
BEGIN
  SELECT RAISE(ABORT, 'line conversation messages history is protected');
END;

CREATE TRIGGER protect_line_conversations_delete
BEFORE DELETE ON line_conversations
BEGIN
  SELECT RAISE(ABORT, 'line conversations history is protected');
END;

CREATE TRIGGER protect_messages_log_delete
BEFORE DELETE ON messages_log
BEGIN
  SELECT RAISE(ABORT, 'messages_log history is protected');
END;

CREATE TRIGGER protect_support_case_attachments_delete
BEFORE DELETE ON support_case_attachments
BEGIN
  SELECT RAISE(ABORT, 'support case attachments cannot be deleted');
END;

CREATE TRIGGER protect_support_case_events_delete
BEFORE DELETE ON support_case_events
BEGIN
  SELECT RAISE(ABORT, 'support_case_events history is protected');
END;

CREATE TRIGGER protect_support_case_followup_events_delete
BEFORE DELETE ON support_case_followup_reminder_events
BEGIN
  SELECT RAISE(ABORT, 'support case follow-up reminder events cannot be deleted');
END;

CREATE TRIGGER protect_support_case_followup_events_update
BEFORE UPDATE ON support_case_followup_reminder_events
BEGIN
  SELECT RAISE(ABORT, 'support case follow-up reminder events cannot be updated');
END;

CREATE TRIGGER protect_support_case_followup_reminders_delete
BEFORE DELETE ON support_case_followup_reminders
BEGIN
  SELECT RAISE(ABORT, 'support case follow-up reminders cannot be deleted');
END;

CREATE TRIGGER protect_support_cases_delete
BEFORE DELETE ON support_cases
BEGIN
  SELECT RAISE(ABORT, 'support_cases history is protected');
END;

CREATE TRIGGER protect_support_escalations_delete
BEFORE DELETE ON support_escalations
BEGIN
  SELECT RAISE(ABORT, 'support_escalations history is protected');
END;

CREATE TRIGGER protect_support_internal_messages_delete
BEFORE DELETE ON support_internal_messages
BEGIN
  SELECT RAISE(ABORT, 'support_internal_messages history is protected');
END;

CREATE TRIGGER protect_terminal_support_escalations_update
BEFORE UPDATE ON support_escalations
WHEN OLD.status IN ('answered', 'closed')
BEGIN
  SELECT RAISE(ABORT, 'completed support escalation is immutable');
END;

CREATE TRIGGER trg_chat_internal_messages_conversation_insert
AFTER INSERT ON chat_internal_messages
BEGIN
  INSERT INTO internal_conversations (
    id, line_account_id, kind, source_id, title, created_by, created_at, updated_at
  )
  VALUES (
    'chat:' || NEW.friend_id,
    COALESCE(NEW.line_account_id, (SELECT line_account_id FROM friends WHERE id = NEW.friend_id)),
    'chat',
    NEW.friend_id,
    (SELECT display_name FROM friends WHERE id = NEW.friend_id),
    NEW.created_by,
    NEW.created_at,
    NEW.created_at
  )
  ON CONFLICT(id) DO UPDATE SET
    title = COALESCE(excluded.title, internal_conversations.title),
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_support_internal_messages_conversation_insert
AFTER INSERT ON support_internal_messages
BEGIN
  INSERT INTO internal_conversations (
    id, line_account_id, kind, source_id, title, created_by, created_at, updated_at
  )
  VALUES (
    'support:' || NEW.case_id,
    NEW.line_account_id,
    'support',
    NEW.case_id,
    (SELECT title FROM support_cases WHERE id = NEW.case_id),
    NEW.created_by,
    NEW.created_at,
    NEW.created_at
  )
  ON CONFLICT(id) DO UPDATE SET
    title = COALESCE(excluded.title, internal_conversations.title),
    updated_at = excluded.updated_at;
END;

-- Reference-only identity used by audit tables for environment-owner actions.
-- Keep this in sync with 072_register_environment_owner_reference.sql.

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
