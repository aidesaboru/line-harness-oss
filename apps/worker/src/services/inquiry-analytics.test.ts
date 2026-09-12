import { describe, expect, it } from 'vitest';
import {
  classifyInquiryGenre,
  classifyInquiryText,
  inferResolutionStatus,
  inquiryGenreSql,
  isInquiryGenreForCategory,
  redactInquirySummary,
} from './inquiry-analytics.js';

describe('inquiry analytics classification', () => {
  it('prioritizes legal rights issues and keeps multi-label evidence', () => {
    const result = classifyInquiryText('内容証明が届き、請求について相談したいです');
    expect(result.primaryCategory).toBe('権利侵害・法務');
    expect(result.labels).toEqual(['権利侵害・法務', '請求・支払い']);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('classifies requested anchor categories', () => {
    expect(classifyInquiryText('確定申告を税理士へ確認したい').primaryCategory).toBe('税務・確定申告');
    expect(classifyInquiryText('自己破産の手続きを進めています').primaryCategory).toBe('破産・債務・廃業');
    expect(classifyInquiryText('事務所から着信がありました').primaryCategory).toBe('事務所への電話');
  });

  it('marks unmatched text for review', () => {
    const result = classifyInquiryText('少し確認したいことがあります');
    expect(result.primaryCategory).toBe('その他');
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('redacts contact details before projection', () => {
    const result = redactInquirySummary('https://example.test a@example.test 090-1234-5678');
    expect(result).toContain('[URL]');
    expect(result).toContain('[メール]');
    expect(result).toContain('[電話番号]');
    expect(result).not.toContain('090-1234-5678');
  });

  it('does not equate every operator reply with confirmed resolution', () => {
    expect(inferResolutionStatus('outgoing', '確認して折り返します')).toBe('answered');
    expect(inferResolutionStatus('incoming', '無事に解決しました')).toBe('resolved');
  });

  it('classifies a category-specific genre with deterministic priority', () => {
    expect(classifyInquiryGenre('事務所への電話', '楽天の購入者から事務所へ着信がありました')).toBe('購入者からの電話');
    expect(classifyInquiryGenre('モール・アカウント', 'Yahooのログイン認証について')).toBe('Yahoo');
    expect(classifyInquiryGenre('権利侵害・法務', '内容証明について弁護士へ相談')).toBe('内容証明・警告');
    expect(classifyInquiryGenre('その他', '判別できない短い連絡')).toBe('内容確認が必要');
  });

  it('validates genres within their parent category', () => {
    expect(isInquiryGenreForCategory('事務所への電話', '着信・折り返し')).toBe(true);
    expect(isInquiryGenreForCategory('事務所への電話', 'その他電話')).toBe(true);
    expect(isInquiryGenreForCategory('税務・確定申告', '着信・折り返し')).toBe(false);
  });

  it('builds a constant-only SQL expression for the same genre rules', () => {
    const sql = inquiryGenreSql('summary_text', 'category_name');
    expect(sql).toContain('CASE category_name');
    expect(sql).toContain("instr(lower(COALESCE(summary_text, '')), lower('内容証明')) > 0");
    expect(sql).toContain("THEN '内容証明・警告'");
    expect(sql).toContain("ELSE '内容確認が必要' END");
  });
});
