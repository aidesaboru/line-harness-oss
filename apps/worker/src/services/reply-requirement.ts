const ACKNOWLEDGEMENT_PARTS = [
  '引き続きよろしくお願いいたします',
  '引き続きよろしくお願いします',
  '今後ともよろしくお願いいたします',
  '今後ともよろしくお願いします',
  'こちらこそよろしくお願いいたします',
  'こちらこそよろしくお願いします',
  'よろしくお願い申し上げます',
  'よろしくお願いいたします',
  'よろしくお願いします',
  '承知いたしました',
  '承知しました',
  'かしこまりました',
  '了解いたしました',
  '了解しました',
  '了解です',
  'わかりました',
  '理解しました',
  '確認いたしました',
  '確認しました',
  '受け取りました',
  '受領しました',
  '届きました',
  '問題ありません',
  '大丈夫です',
  'ありがとうございます',
  'ありがとうございました',
  '助かりました',
  'こちらこそ',
  'はい',
  'いいえ',
] as const;

const ACKNOWLEDGEMENT_PATTERN = new RegExp(
  `^(?:${ACKNOWLEDGEMENT_PARTS.join('|')})+$`,
  'u',
);

function normalizeAcknowledgementText(content: string): string {
  return content
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('宜しく', 'よろしく')
    .replaceAll('有難う', 'ありがとう')
    .replaceAll('分かりました', 'わかりました')
    .replaceAll('お願い致します', 'お願いいたします')
    .replaceAll('承知致しました', '承知いたしました')
    .replaceAll('了解致しました', '了解いたしました')
    .replaceAll('確認致しました', '確認いたしました')
    .replace(/[\s\u3000。、,.!！…・〜~:：;；'"`「」『』（）()【】\[\]]/gu, '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu, '');
}

/**
 * Returns true only for short customer messages that close the conversation.
 * A question mark is an explicit override so mixed messages stay actionable.
 */
export function isReplyNotRequiredIncoming(messageType: string, content: string): boolean {
  if (messageType !== 'text') return false;

  const raw = content.trim();
  if (!raw || raw.length > 160 || /[?？]/u.test(raw)) return false;

  const normalized = normalizeAcknowledgementText(raw);
  if (!normalized) return true;
  return ACKNOWLEDGEMENT_PATTERN.test(normalized);
}
