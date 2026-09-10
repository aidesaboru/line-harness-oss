import { describe, expect, test, vi } from 'vitest';
import {
  buildNoEligibleTextSummary,
  generateSalesCustomerSemanticSummary,
  prepareSalesCustomerSemanticSource,
  redactSalesCustomerSemanticText,
  SALES_CUSTOMER_SEMANTIC_SUMMARY_MODEL,
  SalesCustomerSemanticSummaryError,
} from './sales-customer-semantic-summary.js';

describe('sales customer semantic summary', () => {
  test('redacts identifiers, amounts, and secrets before building a bounded transcript', () => {
    const source = prepareSalesCustomerSemanticSource([
      {
        direction: 'incoming',
        createdAt: '2026-09-09T10:00:00+09:00',
        content: '田中商事の田中様です。090-1234-5678、test@example.com、https://example.com、12,000円、口座番号 1234567、パスワード: abc123',
      },
      {
        direction: 'outgoing',
        createdAt: '2026-09-09T11:00:00+09:00',
        content: '返金手順を確認します。',
      },
    ], ['田中商事']);

    expect(source.transcript).not.toContain('田中商事');
    expect(source.transcript).not.toContain('090-1234-5678');
    expect(source.transcript).not.toContain('test@example.com');
    expect(source.transcript).not.toContain('example.com');
    expect(source.transcript).not.toContain('12,000円');
    expect(source.transcript).not.toContain('1234567');
    expect(source.transcript).not.toContain('abc123');
    expect(source.transcript).toContain('返金手順を確認します');
    expect(source.messageCount).toBe(2);
    expect(source.evidenceIds).toEqual(['M1', 'M2']);
    expect(source.fingerprintInput).not.toContain('田中商事');
  });

  test('normalizes ordering and keeps the latest messages within the input limit', () => {
    const source = prepareSalesCustomerSemanticSource([
      { direction: 'incoming', createdAt: '2026-09-10T10:00:00+09:00', content: '新しい相談' },
      { direction: 'outgoing', createdAt: '2026-09-09T10:00:00+09:00', content: '以前の回答' },
    ]);

    expect(source.transcript.indexOf('以前の回答')).toBeLessThan(source.transcript.indexOf('新しい相談'));
    expect(source.sourceFromAt).toBe('2026-09-09T10:00:00+09:00');
    expect(source.sourceToAt).toBe('2026-09-10T10:00:00+09:00');
    expect(source.estimatedInputTokens).toBeGreaterThan(0);
  });

  test('never exceeds the total transcript bound when many messages are present', () => {
    const source = prepareSalesCustomerSemanticSource(Array.from({ length: 80 }, (_, index) => ({
      direction: index % 2 === 0 ? 'incoming' as const : 'outgoing' as const,
      createdAt: `2026-09-${String((index % 28) + 1).padStart(2, '0')}T10:00:00+09:00`,
      content: `内容${index}${'あ'.repeat(590)}`,
    })));

    expect(source.transcript.length).toBeLessThanOrEqual(12_000);
    expect(source.messageCount).toBeLessThan(80);
    expect(source.transcript).toContain('内容79');
  });

  test('creates four grounded sections and never adds a sales status', async () => {
    const source = prepareSalesCustomerSemanticSource([
      { direction: 'incoming', createdAt: '2026-09-09T10:00:00+09:00', content: '返品方法を知りたいです。' },
      { direction: 'outgoing', createdAt: '2026-09-09T11:00:00+09:00', content: '返送先を案内しました。' },
    ]);
    const run = vi.fn().mockResolvedValue({
      response: JSON.stringify({
        consultation: { text: '返品方法について相談している。', evidence: ['M1'] },
        responseHistory: { text: '担当者が返送先を案内した。', evidence: ['M2'] },
        currentSituation: { text: '返送待ちかどうかは確認できません。', evidence: ['M2'] },
        nextAction: { text: '返送状況を確認する。', evidence: ['M1', 'M2'] },
      }),
      usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
    });

    const result = await generateSalesCustomerSemanticSummary(
      { run } as unknown as Ai,
      source,
      '2026-09-10T12:00:00+09:00',
    );

    expect(run).toHaveBeenCalledWith(SALES_CUSTOMER_SEMANTIC_SUMMARY_MODEL, expect.objectContaining({
      temperature: 0,
      response_format: expect.objectContaining({ type: 'json_schema' }),
    }));
    expect(JSON.stringify(run.mock.calls)).toContain('要約基準日時: 2026-09-10T12:00:00+09:00');
    expect(result.text).toContain('【相談内容】');
    expect(result.text).toContain('返品方法について相談');
    expect(result.text).toContain('【次の対応】');
    expect(result.text).toContain('営業ステータスを判定・変更しません');
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 80, totalTokens: 200 });
    expect(result.attempts).toBe(1);
  });

  test('rejects unknown evidence and retries once without logging transcript data', async () => {
    const source = prepareSalesCustomerSemanticSource([
      { direction: 'incoming', createdAt: '2026-09-09', content: '契約書を確認してください。' },
    ]);
    const valid = {
      consultation: { text: '契約書の確認を依頼している。', evidence: ['M1'] },
      responseHistory: { text: '確認できません。', evidence: [] },
      currentSituation: { text: '確認待ちである。', evidence: ['M1'] },
      nextAction: { text: '契約書を確認する。', evidence: ['M1'] },
    };
    const run = vi.fn()
      .mockResolvedValueOnce({
        response: JSON.stringify({ ...valid, nextAction: { text: '確認する。', evidence: ['M99'] } }),
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValueOnce({
        response: JSON.stringify(valid),
        usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 },
      });

    const result = await generateSalesCustomerSemanticSummary({ run } as unknown as Ai, source);
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.usage).toEqual({ promptTokens: 21, completionTokens: 11, totalTokens: 32 });
  });

  test('rejects extra JSON fields and evidence attached to an unknown section', async () => {
    const source = prepareSalesCustomerSemanticSource([
      { direction: 'incoming', createdAt: '2026-09-09', content: '契約書を確認してください。' },
    ]);
    const valid = {
      consultation: { text: '契約書の確認依頼。', evidence: ['M1'] },
      responseHistory: { text: '確認できません。', evidence: [] },
      currentSituation: { text: '確認できません。', evidence: [] },
      nextAction: { text: '契約書を確認する依頼がある。', evidence: ['M1'] },
    };
    const run = vi.fn()
      .mockResolvedValueOnce({ response: JSON.stringify({ ...valid, status: 'normal' }) })
      .mockResolvedValueOnce({
        response: JSON.stringify({ ...valid, currentSituation: { text: '確認できません。', evidence: ['M1'] } }),
      });

    await expect(generateSalesCustomerSemanticSummary({ run } as unknown as Ai, source)).rejects.toEqual(
      expect.objectContaining<SalesCustomerSemanticSummaryError>({ kind: 'invalid_ai_response' }),
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('returns a truthful fixed summary when no eligible text exists', () => {
    expect(buildNoEligibleTextSummary()).toContain('テキストメッセージを確認できませんでした');
    expect(buildNoEligibleTextSummary()).toContain('元のチャットや添付内容を人が確認');
  });

  test('classifies a missing binding without exposing source content', async () => {
    const source = prepareSalesCustomerSemanticSource([
      { direction: 'incoming', createdAt: '2026-09-09', content: '秘密の相談本文' },
    ]);
    await expect(generateSalesCustomerSemanticSummary(undefined, source)).rejects.toEqual(
      expect.objectContaining<SalesCustomerSemanticSummaryError>({ kind: 'ai_unavailable' }),
    );
  });

  test('redacts output independently from known input terms', () => {
    expect(redactSalesCustomerSemanticText('株式会社サンプルの所在地は東京都渋谷区1-2-3。連絡先は08012345678、URLはhttps://example.jpです。'))
      .toBe('[会社名非表示]の所在地は[住所非表示]。連絡先は[電話番号非表示]、URLは[URL非表示]。');
  });
});
