import { describe, expect, test } from 'vitest';
import { isReplyNotRequiredIncoming } from './reply-requirement.js';

describe('isReplyNotRequiredIncoming', () => {
  test.each([
    'かしこまりました',
    '承知しました。',
    'はい ありがとうございます',
    'ありがとうございます！\n引き続きよろしくお願いいたします🙏',
    'こちらこそ宜しくお願い致します',
    'こちらこそ よろしくお願い致します🤲 ありがとうございます😊',
    '分かりました',
    '問題ありません',
    '😊🙏',
  ])('締めの短文を返信不要として扱う: %s', (content) => {
    expect(isReplyNotRequiredIncoming('text', content)).toBe(true);
  });

  test.each([
    '確認をお願いします',
    'かしこまりました。追加で確認をお願いします',
    '承知しました。いつ頃になりますか？',
    'ありがとうございます。商品がまだ届いていません',
    'よろしくお願いします。決算月を教えてください',
  ])('問い合わせや依頼を含む文面は要返信として残す: %s', (content) => {
    expect(isReplyNotRequiredIncoming('text', content)).toBe(false);
  });

  test('画像やスタンプなどの非テキストは文面だけで自動除外しない', () => {
    expect(isReplyNotRequiredIncoming('image', 'ありがとうございます')).toBe(false);
    expect(isReplyNotRequiredIncoming('sticker', 'sticker_id_12345')).toBe(false);
  });
});
