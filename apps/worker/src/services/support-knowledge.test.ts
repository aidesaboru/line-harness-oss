import { describe, expect, test } from 'vitest';
import {
  deriveOperationalKnowledge,
  deriveOperationalKnowledgeSegments,
  parseKnowledgeBody,
} from './support-knowledge.js';

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
    expect(result.qualityScore).toBeLessThan(100)
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

  test.each([
    {
      question: [
        'こちらのご対応と返信をお願いします。',
        'AIUのオールスターズという保険について、契約内容を確認したいです。',
      ].join('\n'),
      expectedTitle: 'AIUのオールスターズ保険の契約内容',
    },
    {
      question: [
        '本件のご確認をお願いいたします。',
        '振込口座の名義変更はどのように行いますか？',
      ].join('\n'),
      expectedTitle: '振込口座の名義変更',
    },
    {
      question: [
        'こちらの回答をお願いします。',
        '契約更新時の審査結果はいつ分かりますか？',
      ].join('\n'),
      expectedTitle: '契約更新時の審査結果',
    },
  ])('uses a concrete topic instead of a generic request: $expectedTitle', ({ question, expectedTitle }) => {
    const result = deriveOperationalKnowledge({
      title: 'こちらのご対応と返信をお願いします',
      body: [
        '【問い合わせ内容】',
        question,
        '',
        '【解決回答】',
        '対象情報を確認後、契約者本人へ結果をご案内してください。',
      ].join('\n'),
    });

    expect(result.title).toBe(expectedTitle)
    expect(result.resolution).toBe('対象情報を確認後、契約者本人へ結果をご案内してください。')
  });

  test('does not reuse a generic request when no concrete title is available', () => {
    const result = deriveOperationalKnowledge({
      title: 'こちらのご対応と返信をお願いします',
      body: '【問い合わせ内容】\nこちらのご確認をお願いいたします。\n\n【解決回答】\n対象情報を確認してご案内してください。',
    });

    expect(result.title).toBe('対応ナレッジ')
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

  test('does not treat a relayed request from another case as a resolved answer', () => {
    const result = deriveOperationalKnowledge({
      title: '引き継ぎ前の料金精算について',
      body: [
        '【問い合わせ内容】',
        '引き継ぎ前に発生した楽天市場の料金はどちらが負担しますか？',
        '',
        '【解決回答】',
        '引き継ぎ前までに発生した楽天市場のプラン料金等について、弊社側で負担・精算する認識でよいか確認依頼がありました。',
        '楽天銀行への入金がされておらず未払いとなっているため、本日中に必ず対応し、対応完了後に報告してほしいとのことです。',
      ].join('\n'),
    });

    expect(result.resolution).toBe('')
    expect(result.procedure).toBe('')
    expect(result.status).toBe('unresolved')
  });

  test('does not treat a request to another assignee as a resolved answer', () => {
    const result = deriveOperationalKnowledge({
      title: '請求金額の確認',
      body: [
        '【問い合わせ内容】',
        '請求金額が契約内容と異なる場合はどうすればよいですか？',
        '',
        '【解決回答】',
        '@吉田さん、請求担当への確認とご対応をお願いします。担当部署では確認済みです。',
      ].join('\n'),
    });

    expect(result.resolution).toBe('')
    expect(result.status).toBe('unresolved')
  });

  test('does not invent a procedure from unselected conversation blocks', () => {
    const result = deriveOperationalKnowledge({
      title: '返品できる条件',
      body: [
        '【問い合わせ内容】',
        '購入者から返品希望があった場合、どの条件なら受け付けられますか？',
        '',
        '【解決回答】',
        '返品は未開封の場合のみ可能です。返金は商品到着後に処理します。',
        '',
        '---',
        '',
        '返送先住所を確認して購入者へ案内してください。',
      ].join('\n'),
    });

    expect(result.resolution).toContain('返品は未開封の場合のみ可能です')
    expect(result.procedure).toBe('')
  });

  test('extracts procedures only from explicit steps in the selected answer', () => {
    const result = deriveOperationalKnowledge({
      title: '返金処理の手順',
      body: [
        '【問い合わせ内容】',
        '返品受付後の返金処理はどのように進めますか？',
        '',
        '【解決回答】',
        '返品商品が到着してから返金します。',
        '1. 注文番号と到着した商品を照合する',
        '2. 管理画面で返金処理を行う',
        '3. 購入者へ返金完了を連絡する',
      ].join('\n'),
    });

    expect(result.procedure).toBe([
      '1. 注文番号と到着した商品を照合する',
      '2. 管理画面で返金処理を行う',
      '3. 購入者へ返金完了を連絡する',
    ].join('\n'))
  });

  test.each([
    '<@U12345678>',
    '@社内メンバー02',
  ])('keeps knowledge containing unresolved member notation out of ready: %s', (member) => {
    const result = deriveOperationalKnowledge({
      title: '契約更新の案内方法',
      body: [
        '【問い合わせ内容】',
        '契約更新の審査が完了した場合はどのように案内しますか？',
        '',
        '【解決回答】',
        `審査結果を契約情報と照合したうえで、${member}の承認後に契約者本人へ更新結果をご案内してください。`,
      ].join('\n'),
    });

    expect(result.resolution).toContain(member)
    expect(result.status).toBe('needs_review')
    expect(result.reviewNote).toContain('メンバー表記')
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

  test('splits a long-running Slack thread into adjacent request and answer pairs', () => {
    const sourceBody = 'Slack thread source stays unchanged';
    const segments = deriveOperationalKnowledgeSegments({
      title: 'こちらのご対応をお願いいたします',
      body: sourceBody,
      question: '@社内メンバー04\n壁掛け時計について折り返し電話をお願いできますでしょうか？',
      answer: [
        '@社内メンバー06 承知いたしました。対応いたします。',
        '',
        '---',
        '',
        '@社内メンバー04\n返品商品が着払いで届きました。送料の返金対応をお願いいたします。',
        '',
        '---',
        '',
        '@社内メンバー06\n送料は振込済みです。返品商品は破棄してください。',
        '',
        '---',
        '',
        '@社内メンバー07\nヤフーショッピングから営業電話がありました。対応は必要でしょうか？',
        '',
        '---',
        '',
        '@社内メンバー06\n営業電話のため対応は不要です。',
      ].join('\n'),
    });

    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({
      questionBlockIndex: 1,
      answerBlockIndex: 2,
      sourceBody,
    })
    expect(segments[0].question).toContain('返品商品')
    expect(segments[0].resolution).toContain('振込済み')
    expect(segments[1].question).toContain('営業電話')
    expect(segments[1].resolution).toContain('対応は不要')
  });

  test('does not pair an unanswered request with a later unrelated request', () => {
    const segments = deriveOperationalKnowledgeSegments({
      title: '対応依頼',
      body: 'original',
      question: '時計の問い合わせについて折り返しをお願いできますでしょうか？',
      answer: [
        '承知しました。',
        '',
        '---',
        '',
        '購入者から返品希望が来ています。返金のご対応をお願いいたします。',
        '',
        '---',
        '',
        'COへ対応依頼いたしました。',
        '',
        '---',
        '',
        '契約更新の審査結果はいつ分かりますか？',
        '',
        '---',
        '',
        '審査結果は契約者本人へメールで案内してください。',
      ].join('\n'),
    });

    expect(segments).toHaveLength(1)
    expect(segments[0].question).toContain('契約更新')
    expect(segments[0].resolution).toContain('メールで案内')
  });

  test('rejects adjacent blocks when the topics do not match', () => {
    const segments = deriveOperationalKnowledgeSegments({
      title: '税理士からの書類依頼',
      body: 'original',
      question: '税理士から業務委託契約書と決算書類の提出依頼が来ています。ご対応をお願いいたします。',
      answer: '送料のお振込完了です。返品商品は破棄してください。',
    });

    expect(segments).toHaveLength(0)
  });

  test('rejects workflow follow-up requests as resolutions', () => {
    const segments = deriveOperationalKnowledgeSegments({
      title: '配送状況の確認',
      body: 'original',
      question: '注文商品がまだ届いていません。配送状況と発送予定日を確認してください。',
      answer: 'お手数ですが、こちら完了後にお知らせください。',
    });

    expect(segments).toHaveLength(0)
  });
});
