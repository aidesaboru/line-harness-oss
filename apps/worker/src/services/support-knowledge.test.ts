import { describe, expect, test } from 'vitest';
import { deriveOperationalKnowledge, parseKnowledgeBody } from './support-knowledge.js';

describe('support knowledge structure', () => {
  test('separates a reusable conclusion from Slack noise', () => {
    const result = deriveOperationalKnowledge({
      title: '!channel',
      body: [
        '【問い合わせ内容】',
        '@社内メンバー01',
        '報酬の入金が確認できない場合はどこへ確認すればよいでしょうか？',
        '',
        '【解決回答】',
        '確認します',
        '',
        '---',
        '',
        '経理担当へ対象月と店舗名を共有し、入金状況を確認してから案内してください。',
      ].join('\n'),
    });

    expect(result.title).toContain('報酬の入金')
    expect(result.question).not.toContain('@社内メンバー01')
    expect(result.resolution).toContain('経理担当')
    expect(result.resolution).not.toContain('確認します')
    expect(result.status).toBe('ready')
    expect(result.qualityScore).toBeGreaterThanOrEqual(70)
  });

  test('marks acknowledgement-only threads as unresolved', () => {
    const result = deriveOperationalKnowledge({
      title: '*回答期限：4/17*',
      body: '【問い合わせ内容】\n返品の可否を確認したいです\n\n【解決回答】\n承知しました',
    });

    expect(result.resolution).toBe('')
    expect(result.status).toBe('unresolved')
    expect(result.reviewNote).toContain('解決した回答')
  });

  test('prefers a concrete answer over a later customer follow-up', () => {
    const result = deriveOperationalKnowledge({
      title: '住民税の負担範囲を確認したい',
      body: [
        '【問い合わせ内容】',
        'EC事業で増えた住民税は補填対象でしょうか？',
        '',
        '【解決回答】',
        '本来は、売上により直接発生する所得税と消費税相当額のみが対象で、住民税は対象外になります。',
        '',
        '---',
        '',
        'こちらのご対応と返信文をお願いいたします。納付期限はいつでしょうか？至急確認できますでしょうか？',
      ].join('\n'),
    });

    expect(result.resolution).toContain('住民税は対象外')
    expect(result.resolution).not.toContain('返信文をお願いいたします')
    expect(result.status).toBe('ready')
  });

  test('does not treat delegation-only updates as a resolved answer', () => {
    const result = deriveOperationalKnowledge({
      title: '配送遅延への回答を確認したい',
      body: '【問い合わせ内容】\n配送遅延についてどう案内すればよいですか？\n\n【解決回答】\nCOに対応依頼いたしました。',
    });

    expect(result.resolution).toBe('')
    expect(result.status).toBe('unresolved')
    expect(result.reviewNote).toContain('解決した回答')
  });

  test('does not treat a multiline response request as the answer', () => {
    const result = deriveOperationalKnowledge({
      title: '楽天からの確認依頼への対応',
      body: [
        '【問い合わせ内容】',
        '楽天から確認の電話が来た場合はどうすればよいでしょうか？',
        '',
        '【解決回答】',
        'こちらの内容確認のため、楽天から連絡があったようですので',
        'ご対応をお願いいたします。',
        '担当者へはどのように回答したらよろしいでしょうか？',
      ].join('\n'),
    });

    expect(result.resolution).toBe('')
    expect(result.status).toBe('unresolved')
  });

  test('rejects a first-line status question followed by quoted customer text', () => {
    const result = deriveOperationalKnowledge({
      title: '返品対応の状況を確認したい',
      body: [
        '【問い合わせ内容】',
        '返品された商品はどのように処理しますか？',
        '',
        '【解決回答】',
        'こちら交換のご対応は完了されていますでしょうか。',
        '購入者から早急に連絡がほしいと言われています。',
      ].join('\n'),
    });

    expect(result.resolution).toBe('')
    expect(result.status).toBe('unresolved')
  });

  test('keeps a short but definitive answer for human review', () => {
    const result = deriveOperationalKnowledge({
      title: '楽天の広告案内への対応',
      body: '【問い合わせ内容】\n楽天から広告案内が届いた場合は対応が必要でしょうか？\n\n【解決回答】\n広告の案内は不要です。',
    });

    expect(result.resolution).toBe('広告の案内は不要です。')
    expect(result.status).toBe('needs_review')
  });

  test('handles long email divider lines without excessive backtracking', () => {
    const result = deriveOperationalKnowledge({
      title: 'モールから届いた案内への対応',
      body: [
        '【問い合わせ内容】',
        '-'.repeat(4_000),
        'モールから届いた広告案内への対応は必要でしょうか？',
        '',
        '【解決回答】',
        '広告の案内は不要です。',
      ].join('\n'),
    });

    expect(result.question).toContain('広告案内')
    expect(result.resolution).toBe('広告の案内は不要です。')
  });

  test('keeps the source body unchanged', () => {
    const body = '【問い合わせ内容】\n質問\n\n【解決回答】\n回答';
    const result = deriveOperationalKnowledge({ title: '確認', body });
    expect(result.sourceBody).toBe(body)
    expect(parseKnowledgeBody(body)).toEqual({ question: '質問', answer: '回答', customer: '', rest: '' })
  });
});
