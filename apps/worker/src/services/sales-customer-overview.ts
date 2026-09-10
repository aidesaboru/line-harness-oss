export const SALES_CUSTOMER_OVERVIEW_PERIOD_DAYS = 90 as const;
export const SALES_CUSTOMER_OVERVIEW_METHOD = 'rules_v1' as const;

export const SALES_CUSTOMER_OVERVIEW_TOPIC_CODES = [
  'payment',
  'accounting',
  'store_operations',
  'cancellation_handover',
  'documents_contracts',
  'orders_customer_support',
  'calls_contact',
  'insurance',
] as const;

export type SalesCustomerOverviewTopicCode = (typeof SALES_CUSTOMER_OVERVIEW_TOPIC_CODES)[number];

export type SalesCustomerOverviewSource = {
  totalMessages: number;
  customerMessages: number;
  staffReplies: number;
  automatedMessages: number;
  activeDays: number;
  mediaMessages: number;
  lastContactAt: string | null;
  lastCustomerMessageAt: string | null;
  lastStaffReplyAt: string | null;
  needsHumanReply: boolean;
  activeSupportCases: number;
  supportCasesInPeriod: number;
  lastSupportUpdatedAt: string | null;
  chatStatus: 'unread' | 'in_progress' | 'resolved' | 'long_term' | null;
  isFollowing: boolean | null;
  topicCodes: SalesCustomerOverviewTopicCode[];
};

const TOPIC_LABELS: Record<SalesCustomerOverviewTopicCode, string> = {
  payment: '決済・支払い',
  accounting: '税務・会計',
  store_operations: '店舗・モール運用',
  cancellation_handover: '契約終了・引き継ぎ',
  documents_contracts: '書類・契約',
  orders_customer_support: '注文・顧客対応',
  calls_contact: '電話・打ち合わせ',
  insurance: '保険・補償',
};

function nonNegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function dateLabel(value: string | null): string {
  if (!value) return '記録なし';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '記録あり';
  return `${Number(match[2])}/${Number(match[3])}`;
}

function chatStateSentence(source: SalesCustomerOverviewSource): string | null {
  const labels: Record<NonNullable<SalesCustomerOverviewSource['chatStatus']>, string> = {
    unread: '未対応',
    in_progress: '対応中',
    resolved: '解決済み',
    long_term: '中長期対応',
  };
  const parts: string[] = [];
  if (source.chatStatus) parts.push(`チャットは「${labels[source.chatStatus]}」`);
  if (source.isFollowing === false) parts.push('LINEはブロック済み');
  return parts.length > 0 ? `${parts.join('、')}です。` : null;
}

export function normalizeSalesCustomerOverviewSource(
  source: SalesCustomerOverviewSource,
): SalesCustomerOverviewSource {
  const topicCodes = SALES_CUSTOMER_OVERVIEW_TOPIC_CODES.filter((code) => source.topicCodes.includes(code));
  return {
    totalMessages: nonNegativeInteger(source.totalMessages),
    customerMessages: nonNegativeInteger(source.customerMessages),
    staffReplies: nonNegativeInteger(source.staffReplies),
    automatedMessages: nonNegativeInteger(source.automatedMessages),
    activeDays: nonNegativeInteger(source.activeDays),
    mediaMessages: nonNegativeInteger(source.mediaMessages),
    lastContactAt: source.lastContactAt || null,
    lastCustomerMessageAt: source.lastCustomerMessageAt || null,
    lastStaffReplyAt: source.lastStaffReplyAt || null,
    needsHumanReply: Boolean(source.needsHumanReply),
    activeSupportCases: nonNegativeInteger(source.activeSupportCases),
    supportCasesInPeriod: nonNegativeInteger(source.supportCasesInPeriod),
    lastSupportUpdatedAt: source.lastSupportUpdatedAt || null,
    chatStatus: source.chatStatus,
    isFollowing: source.isFollowing,
    topicCodes,
  };
}

export function salesCustomerOverviewFingerprintInput(source: SalesCustomerOverviewSource): string {
  return JSON.stringify({
    method: SALES_CUSTOMER_OVERVIEW_METHOD,
    periodDays: SALES_CUSTOMER_OVERVIEW_PERIOD_DAYS,
    source: normalizeSalesCustomerOverviewSource(source),
  });
}

export function buildSalesCustomerOverview(sourceInput: SalesCustomerOverviewSource): string {
  const source = normalizeSalesCustomerOverviewSource(sourceInput);
  const sentences: string[] = [];

  if (source.totalMessages === 0) {
    sentences.push('直近90日間に対象となるLINEメッセージはありません。');
  } else {
    sentences.push(
      `直近90日では、顧客から${source.customerMessages}件、担当者返信${source.staffReplies}件、自動配信${source.automatedMessages}件、合計${source.totalMessages}件の記録があり、やり取り日は${source.activeDays}日です。`,
    );
    sentences.push(
      `最終接触は${dateLabel(source.lastContactAt)}、顧客の最終連絡は${dateLabel(source.lastCustomerMessageAt)}、担当者の最終返信は${dateLabel(source.lastStaffReplyAt)}です。`,
    );
  }

  if (source.needsHumanReply) {
    sentences.push('顧客からの最終連絡後に担当者返信が記録されていないため、返信要否の確認が必要です。');
  } else if (source.customerMessages > 0) {
    sentences.push('顧客からの最終連絡後に担当者返信が記録されています。');
  }

  if (source.activeSupportCases > 0 || source.supportCasesInPeriod > 0) {
    sentences.push(
      `関連チケットは直近90日で${source.supportCasesInPeriod}件、うち対応中は${source.activeSupportCases}件です。`,
    );
  }

  const chatSentence = chatStateSentence(source);
  if (chatSentence) sentences.push(chatSentence);

  if (source.topicCodes.length > 0) {
    const labels = source.topicCodes.map((code) => `「${TOPIC_LABELS[code]}」`).join('、');
    sentences.push(`顧客発言から機械集計した最近の話題は${labels}です。`);
  } else {
    sentences.push('顧客発言から確認できる話題カテゴリはありません。');
  }

  sentences.push('この概要は営業ステータスを判定・変更するものではありません。ステータスは会話確認後に人が設定します。');
  return sentences.join('');
}
