-- EC owner support CRM MVP: cases, escalations, manuals, audit timeline.

CREATE TABLE IF NOT EXISTS support_cases (
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

CREATE TABLE IF NOT EXISTS support_escalations (
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
);

CREATE TABLE IF NOT EXISTS support_manuals (
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
);

CREATE TABLE IF NOT EXISTS support_case_events (
  id              TEXT PRIMARY KEY,
  case_id         TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  actor_id        TEXT,
  actor_name      TEXT,
  body            TEXT NOT NULL DEFAULT '',
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_support_cases_account_status
  ON support_cases(line_account_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_support_cases_friend
  ON support_cases(friend_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_support_cases_due
  ON support_cases(due_at, status);

CREATE INDEX IF NOT EXISTS idx_support_cases_account_due_status
  ON support_cases(line_account_id, due_at, status);

CREATE INDEX IF NOT EXISTS idx_support_cases_assignee
  ON support_cases(primary_assignee, escalation_assignee, status);

CREATE INDEX IF NOT EXISTS idx_support_escalations_case
  ON support_escalations(case_id, created_at);

CREATE INDEX IF NOT EXISTS idx_support_escalations_account_status_due
  ON support_escalations(line_account_id, status, due_at);

CREATE INDEX IF NOT EXISTS idx_support_escalations_assignee
  ON support_escalations(assignee, status, due_at);

CREATE INDEX IF NOT EXISTS idx_support_manuals_account_category
  ON support_manuals(line_account_id, category, is_active);

CREATE INDEX IF NOT EXISTS idx_support_case_events_case
  ON support_case_events(case_id, created_at);

INSERT OR IGNORE INTO support_manuals (
  id, title, category, body, keywords, owner, approved_by, revised_at, is_active
) VALUES
  (
    'manual-reward-check',
    '報酬漏れ確認の一次対応',
    'reward',
    '対象月、店舗名、報酬種類、入金状況、該当スクリーンショットを確認する。一次返信では確認受付と調査予定を伝え、判断は経理または担当者へエスカレーションする。',
    '報酬 支払い 入金 漏れ 吉田 経理',
    '一次管理者',
    '運用責任者',
    '2026-06-11',
    1
  ),
  (
    'manual-delivery-return',
    '商品未着・返品問い合わせの初動',
    'delivery',
    '注文番号、商品名、購入日、配送状況、顧客が受け取った通知内容を確認する。中国側確認が必要な場合は、確認してほしい事項を1つに絞ってエスカレする。',
    '商品未着 返品 配送 注文番号 中国側',
    '一次管理者',
    '運用責任者',
    '2026-06-11',
    1
  ),
  (
    'manual-review-claim',
    'レビュー・クレーム対応の初動',
    'claim',
    '感情的な反論を避け、事実確認、謝意、確認予定を短く伝える。レビュー悪化や返金要求が絡む場合は、顧客主張と発生日時を整理して二次対応へ渡す。',
    'レビュー クレーム 返金 謝罪 初動',
    '一次管理者',
    '運用責任者',
    '2026-06-11',
    1
  ),
  (
    'manual-rights-violation',
    '権利侵害・出品停止の確認項目',
    'rights',
    '商品URL、モール通知、指摘内容、対象画像や商品名、停止期限を集める。法務判断を一次対応者が断定せず、専門担当へ緊急度つきでエスカレする。',
    '権利侵害 出品停止 モール通知 法務 URL',
    '一次管理者',
    '運用責任者',
    '2026-06-11',
    1
  ),
  (
    'manual-tax-contract',
    '税務・契約相談の一次整理',
    'tax_contract',
    '契約名、対象期間、請求書や支払明細、相談したい論点を整理する。税務・法務の回答は断定せず、専門家確認が必要な旨を明示してL3へ回す。',
    '税務 契約 請求書 税理士 弁護士',
    '一次管理者',
    '運用責任者',
    '2026-06-11',
    1
  );
