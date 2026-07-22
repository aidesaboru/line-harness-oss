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

  test('keeps the source body unchanged', () => {
    const body = '【問い合わせ内容】\n質問\n\n【解決回答】\n回答';
    const result = deriveOperationalKnowledge({ title: '確認', body });
    expect(result.sourceBody).toBe(body)
    expect(parseKnowledgeBody(body)).toEqual({ question: '質問', answer: '回答', customer: '', rest: '' })
  });
});
