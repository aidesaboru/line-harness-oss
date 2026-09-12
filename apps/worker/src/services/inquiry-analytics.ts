import { jstNow } from '@line-crm/db';

export const INQUIRY_CLASSIFICATION_VERSION = 'rules-v1';
export const INQUIRY_EPISODE_GAP_MS = 72 * 60 * 60 * 1000;

export const INQUIRY_CATEGORIES = [
  '権利侵害・法務',
  '事務所への電話',
  '税務・確定申告',
  '破産・債務・廃業',
  '契約・退会',
  '請求・支払い',
  '受注・配送・返品',
  'モール・アカウント',
  '商品登録・店舗運用',
  '広告・集客',
  'システム・操作',
  'その他',
] as const;

export type InquiryCategory = (typeof INQUIRY_CATEGORIES)[number];
export type InquiryResolutionStatus = 'open' | 'answered' | 'resolved' | 'unknown';

type InquiryGenreRule = { genre: string; words: readonly string[] };

export const INQUIRY_GENRE_RULES: Record<InquiryCategory, readonly InquiryGenreRule[]> = {
  '権利侵害・法務': [
    { genre: '内容証明・警告', words: ['内容証明', '警告書', '警告'] },
    { genre: '商標・知財', words: ['商標', '著作権', '知的財産', '権利侵害', '知財'] },
    { genre: '弁護士・法的手続き', words: ['弁護士', '法的措置', '訴訟', '裁判', '法務'] },
  ],
  '事務所への電話': [
    { genre: '購入者からの電話', words: ['購入者', 'お客様', 'お客さま', '買った方', '注文者'] },
    { genre: 'モール・関係先からの電話', words: ['楽天', 'yahoo', 'amazon', 'モール', '配送会社', '税務署', 'カード会社'] },
    { genre: '着信・折り返し', words: ['着信', '折り返し', '折返し', '電話があり', '電話あり'] },
    { genre: '電話番号・連絡先', words: ['電話番号', '代表番号', '連絡先', '番号を'] },
  ],
  '税務・確定申告': [
    { genre: '確定申告・決算', words: ['確定申告', '決算', '申告書'] },
    { genre: '消費税・インボイス', words: ['消費税', 'インボイス', '適格請求書'] },
    { genre: '税理士・資料共有', words: ['税理士', '税務署', '税務資料', '資料共有'] },
    { genre: '会計処理・勘定科目', words: ['会計処理', '勘定科目', '仕訳', '経費', '帳簿'] },
  ],
  '破産・債務・廃業': [
    { genre: '自己破産・債務整理', words: ['自己破産', '債務整理', '債務'] },
    { genre: '口座凍結・差押え', words: ['口座凍結', '凍結', '差押え', '差し押さえ'] },
    { genre: '廃業・倒産', words: ['廃業', '倒産', '事業停止'] },
  ],
  '契約・退会': [
    { genre: '退会・解約', words: ['退会', '解約', '契約解除', '契約終了'] },
    { genre: '契約内容・同意', words: ['契約内容', '契約書', '同意', '規約'] },
    { genre: '休会・停止', words: ['休会', '一時停止', '利用停止', '停止した'] },
  ],
  '請求・支払い': [
    { genre: '請求書・領収書', words: ['請求書', '領収書', '明細'] },
    { genre: '入金・振込', words: ['入金', '振込', '振り込み', '口座'] },
    { genre: '報酬・精算', words: ['報酬', '精算', '売上金'] },
    { genre: '未払い・不足', words: ['未払い', '不足', '未入金', '滞納'] },
    { genre: '手数料', words: ['手数料'] },
  ],
  '受注・配送・返品': [
    { genre: '配送・未着', words: ['配送', '発送', '未着', '届か', '追跡'] },
    { genre: '返品・交換', words: ['返品', '交換'] },
    { genre: '返金', words: ['返金'] },
    { genre: '注文・キャンセル', words: ['注文', '受注', 'キャンセル'] },
  ],
  'モール・アカウント': [
    { genre: '楽天', words: ['楽天'] },
    { genre: 'Yahoo', words: ['yahoo'] },
    { genre: 'Amazon', words: ['amazon'] },
    { genre: 'ログイン・認証', words: ['ログイン', 'パスワード', '認証', '二段階'] },
    { genre: 'アカウント停止・審査', words: ['アカウント停止', '利用停止', '審査', '凍結'] },
  ],
  '商品登録・店舗運用': [
    { genre: '商品登録・出品', words: ['商品登録', '出品', '登録商品'] },
    { genre: '在庫・価格', words: ['在庫', '価格', '値段'] },
    { genre: '商品画像・ページ', words: ['商品画像', '商品ページ', '画像', 'ページ編集'] },
    { genre: '店舗運用', words: ['店舗運用', 'ショップ運営', '店舗設定'] },
  ],
  '広告・集客': [
    { genre: '広告運用', words: ['広告運用', '広告費', '出稿', '広告'] },
    { genre: '集客・流入', words: ['集客', '流入', 'アクセス'] },
    { genre: 'クーポン・販促', words: ['クーポン', '販促', 'セール'] },
  ],
  'システム・操作': [
    { genre: 'エラー・不具合', words: ['エラー', '不具合', 'できません', '動かない'] },
    { genre: '操作方法', words: ['操作方法', 'やり方', '方法を', 'どうすれば'] },
    { genre: '設定・表示', words: ['設定', '表示され', '画面', '反映され'] },
  ],
  'その他': [
    { genre: '進捗確認・催促', words: ['進捗', '状況確認', 'どうなって', 'まだですか', '催促'] },
    { genre: '書類・資料', words: ['書類', '資料', '申請書', '証明書'] },
    { genre: '写真・ファイル共有', words: ['写真', '画像', 'ファイル', '添付'] },
    { genre: '登録情報変更', words: ['住所変更', '名義変更', '登録情報', '変更したい'] },
    { genre: '感謝・完了連絡', words: ['ありがとう', '助かりました', '完了しました', '承知しました'] },
    { genre: '運営相談', words: ['相談', '運営', '売上', '今後'] },
  ],
};

const FALLBACK_GENRES: Record<InquiryCategory, string> = {
  '権利侵害・法務': 'その他法務',
  '事務所への電話': 'その他電話',
  '税務・確定申告': 'その他税務',
  '破産・債務・廃業': 'その他債務・廃業',
  '契約・退会': 'その他契約',
  '請求・支払い': 'その他請求・支払い',
  '受注・配送・返品': 'その他受注・配送',
  'モール・アカウント': 'その他モール・アカウント',
  '商品登録・店舗運用': 'その他店舗運用',
  '広告・集客': 'その他広告・集客',
  'システム・操作': 'その他システム・操作',
  'その他': '内容確認が必要',
};

export function classifyInquiryGenre(category: InquiryCategory, text: string): string {
  const normalized = text.toLocaleLowerCase('ja-JP');
  return INQUIRY_GENRE_RULES[category].find((rule) => rule.words.some((word) => normalized.includes(word.toLocaleLowerCase('ja-JP'))))?.genre
    ?? FALLBACK_GENRES[category];
}

export function isInquiryGenreForCategory(category: InquiryCategory, genre: string): boolean {
  return genre === FALLBACK_GENRES[category] || INQUIRY_GENRE_RULES[category].some((rule) => rule.genre === genre);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function inquiryGenreSql(summaryColumn = 'inquiry_summary', categoryColumn = 'primary_category'): string {
  const text = `lower(COALESCE(${summaryColumn}, ''))`;
  const categoryCases = INQUIRY_CATEGORIES.map((category) => {
    const rules = INQUIRY_GENRE_RULES[category].map((rule) => {
      const wordChecks = rule.words.map((word) => `instr(${text}, lower(${sqlLiteral(word)})) > 0`).join(' OR ');
      return `WHEN ${wordChecks} THEN ${sqlLiteral(rule.genre)}`;
    }).join(' ');
    return `WHEN ${sqlLiteral(category)} THEN CASE ${rules} ELSE ${sqlLiteral(FALLBACK_GENRES[category])} END`;
  }).join(' ');
  return `CASE ${categoryColumn} ${categoryCases} ELSE '内容確認が必要' END`;
}

const CATEGORY_RULES: ReadonlyArray<{ category: InquiryCategory; words: readonly string[] }> = [
  { category: '権利侵害・法務', words: ['権利侵害', '著作権', '商標', '知的財産', '内容証明', '弁護士', '法的措置', '訴訟', '警告書'] },
  { category: '破産・債務・廃業', words: ['自己破産', '破産', '倒産', '債務整理', '債務', '廃業'] },
  { category: '税務・確定申告', words: ['確定申告', '消費税', 'インボイス', '税理士', '税務', '税金', '納税'] },
  { category: '事務所への電話', words: ['事務所へ電話', '事務所に電話', '事務所から電話', '着信', '折り返し', '代表番号'] },
  { category: '契約・退会', words: ['退会', '解約', '休会', '契約解除', '契約終了', '契約'] },
  { category: '請求・支払い', words: ['請求書', '請求', '支払い', '支払', '入金', '振込', '決済', '未払い'] },
  { category: '受注・配送・返品', words: ['返品', '返金', '発送', '配送', '注文', '受注', 'キャンセル', '届か'] },
  { category: '広告・集客', words: ['広告', '集客', 'アクセス', '流入', '販促', 'クーポン'] },
  { category: 'モール・アカウント', words: ['楽天', 'Yahoo', 'Amazon', 'メルカリ', 'ログイン', 'パスワード', 'アカウント', '認証'] },
  { category: '商品登録・店舗運用', words: ['商品登録', '出品', '在庫', '価格変更', '商品画像', '商品ページ', 'ショップ運営', '店舗運営'] },
  { category: 'システム・操作', words: ['操作方法', 'エラー', '不具合', '表示され', 'できません', 'やり方', '設定方法'] },
];

const RESOLVED_WORDS = ['解決しました', '解決いたしました', '承知しました', '確認できました', 'ありがとうございます', '問題ありません', '完了しました'];

function includesAny(text: string, words: readonly string[]): boolean {
  return words.some((word) => text.includes(word));
}

export function classifyInquiryText(text: string): { primaryCategory: InquiryCategory; labels: InquiryCategory[]; confidence: number } {
  const labels = CATEGORY_RULES.filter((rule) => includesAny(text, rule.words)).map((rule) => rule.category);
  return {
    primaryCategory: labels[0] ?? 'その他',
    labels,
    confidence: labels.length > 0 ? 0.86 : 0.35,
  };
}

export function redactInquirySummary(text: string, maxLength = 360): string {
  return text
    .replace(/https?:\/\/\S+/giu, '[URL]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[メール]')
    .replace(/(?:\+?81[-\s]?)?0\d{1,4}[-\s]\d{1,4}[-\s]\d{3,4}/gu, '[電話番号]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

export function inferResolutionStatus(direction: 'incoming' | 'outgoing', text: string): InquiryResolutionStatus {
  if (direction === 'incoming') return includesAny(text, RESOLVED_WORDS) ? 'resolved' : 'open';
  return includesAny(text, RESOLVED_WORDS) ? 'resolved' : 'answered';
}

type QueueRow = { id: string; source_table: 'messages_log' | 'line_conversation_messages'; source_message_id: string; attempts: number };
type SourceMessage = {
  subjectKind: 'friend' | 'conversation'; subjectId: string; lineAccountId: string | null;
  customerNumber: string | null; direction: 'incoming' | 'outgoing'; content: string; createdAt: string;
};

async function loadSourceMessage(db: D1Database, row: QueueRow): Promise<SourceMessage | null> {
  if (row.source_table === 'messages_log') {
    const message = await db.prepare(
      `SELECT m.friend_id AS subject_id, m.line_account_id, m.direction, m.content, m.created_at,
              COALESCE(json_extract(f.metadata, '$.customerNumber'), json_extract(f.metadata, '$.customer_number'),
                       json_extract(f.metadata, '$.customerNo'), json_extract(f.metadata, '$.customer_no')) AS customer_number
       FROM messages_log m INNER JOIN friends f ON f.id = m.friend_id
       WHERE m.id = ? AND m.deleted_at IS NULL AND m.message_type = 'text'`,
    ).bind(row.source_message_id).first<Record<string, unknown>>();
    if (!message) return null;
    return {
      subjectKind: 'friend', subjectId: String(message.subject_id),
      lineAccountId: typeof message.line_account_id === 'string' ? message.line_account_id : null,
      customerNumber: message.customer_number == null ? null : String(message.customer_number),
      direction: message.direction === 'outgoing' ? 'outgoing' : 'incoming',
      content: String(message.content ?? ''), createdAt: String(message.created_at),
    };
  }
  const message = await db.prepare(
    `SELECT m.conversation_id AS subject_id, m.line_account_id, m.direction, m.content, m.created_at,
            COALESCE(json_extract(c.customer_metadata, '$.customerNumber'), json_extract(c.customer_metadata, '$.customer_number'),
                     json_extract(c.customer_metadata, '$.customerNo'), json_extract(c.customer_metadata, '$.customer_no')) AS customer_number
     FROM line_conversation_messages m INNER JOIN line_conversations c ON c.id = m.conversation_id
     WHERE m.id = ? AND m.deleted_at IS NULL AND m.message_type = 'text'`,
  ).bind(row.source_message_id).first<Record<string, unknown>>();
  if (!message) return null;
  return {
    subjectKind: 'conversation', subjectId: String(message.subject_id),
    lineAccountId: typeof message.line_account_id === 'string' ? message.line_account_id : null,
    customerNumber: message.customer_number == null ? null : String(message.customer_number),
    direction: message.direction === 'outgoing' ? 'outgoing' : 'incoming',
    content: String(message.content ?? ''), createdAt: String(message.created_at),
  };
}

async function projectMessage(db: D1Database, row: QueueRow, message: SourceMessage): Promise<void> {
  const now = jstNow();
  const cutoff = new Date(Date.parse(message.createdAt) - INQUIRY_EPISODE_GAP_MS).toISOString();
  const open = await db.prepare(
    `SELECT id, inquiry_summary, labels_json FROM inquiry_cases
     WHERE source_kind = 'live' AND subject_kind = ? AND subject_id = ? AND last_activity_at >= ?
     ORDER BY last_activity_at DESC LIMIT 1`,
  ).bind(message.subjectKind, message.subjectId, cutoff).first<{ id: string; inquiry_summary: string; labels_json: string }>();
  const summary = redactInquirySummary(message.content);
  if (open) {
    const existingLabels = JSON.parse(open.labels_json) as string[];
    const classification = classifyInquiryText(`${open.inquiry_summary} ${message.content}`);
    const labels = [...new Set([...existingLabels, ...classification.labels])];
    await db.prepare(
      `UPDATE inquiry_cases SET last_activity_at = ?, primary_category = ?, labels_json = ?,
         resolution_summary = CASE WHEN ? = 'outgoing' THEN ? ELSE resolution_summary END,
         resolution_status = ?, confidence = ?, classification_version = ?, updated_at = ? WHERE id = ?`,
    ).bind(message.createdAt, classification.primaryCategory, JSON.stringify(labels), message.direction, summary,
      inferResolutionStatus(message.direction, message.content), classification.confidence,
      INQUIRY_CLASSIFICATION_VERSION, now, open.id).run();
    return;
  }
  if (message.direction === 'outgoing') return;
  const classification = classifyInquiryText(message.content);
  await db.prepare(
    `INSERT INTO inquiry_cases
      (id, line_account_id, subject_kind, subject_id, customer_number, opened_at, last_activity_at,
       primary_category, labels_json, inquiry_summary, resolution_summary, resolution_status,
       confidence, source_kind, source_ref, classification_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), message.lineAccountId, message.subjectKind, message.subjectId,
    message.customerNumber, message.createdAt, message.createdAt, classification.primaryCategory,
    JSON.stringify(classification.labels), summary, null, inferResolutionStatus(message.direction, message.content),
    classification.confidence, `${row.source_table}:${row.source_message_id}`,
    INQUIRY_CLASSIFICATION_VERSION, now, now).run();
}

export async function processInquiryAnalysisQueue(db: D1Database, options: { limit?: number; now?: Date } = {}) {
  const now = (options.now ?? new Date()).toISOString();
  const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
  const result = await db.prepare(
    `SELECT id, source_table, source_message_id, attempts FROM inquiry_analysis_queue
     WHERE status IN ('pending', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY created_at LIMIT ?`,
  ).bind(now, limit).all<QueueRow>();
  let completed = 0; let failed = 0;
  for (const row of result.results ?? []) {
    try {
      await db.prepare(`UPDATE inquiry_analysis_queue SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?`).bind(now, row.id).run();
      const message = await loadSourceMessage(db, row);
      if (message) await projectMessage(db, row, message);
      await db.prepare(`UPDATE inquiry_analysis_queue SET status = 'completed', last_error_kind = NULL, updated_at = ? WHERE id = ?`).bind(now, row.id).run();
      completed += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const retryAt = new Date(Date.parse(now) + Math.min(60, 2 ** attempts) * 60_000).toISOString();
      await db.prepare(`UPDATE inquiry_analysis_queue SET status = 'failed', last_error_kind = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
        .bind(error instanceof Error ? error.name : 'error', retryAt, now, row.id).run();
      failed += 1;
    }
  }
  return { scanned: result.results?.length ?? 0, completed, failed };
}
