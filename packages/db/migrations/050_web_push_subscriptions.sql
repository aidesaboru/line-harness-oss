-- Chrome / browser Web Push subscriptions for PC notifications.
-- The endpoint is browser-generated; p256dh/auth are public subscription keys.

CREATE TABLE IF NOT EXISTS web_push_subscriptions (
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

CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_staff
  ON web_push_subscriptions(staff_id, is_active, last_seen_at);

CREATE TABLE IF NOT EXISTS web_push_deliveries (
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

CREATE INDEX IF NOT EXISTS idx_web_push_deliveries_subscription
  ON web_push_deliveries(subscription_id, created_at);

CREATE INDEX IF NOT EXISTS idx_web_push_deliveries_notification
  ON web_push_deliveries(notification_id);
