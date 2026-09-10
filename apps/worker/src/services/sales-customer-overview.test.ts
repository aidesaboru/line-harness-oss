import { describe, expect, test } from 'vitest';
import {
  buildSalesCustomerOverview,
  salesCustomerOverviewFingerprintInput,
  type SalesCustomerOverviewSource,
} from './sales-customer-overview.js';

const source: SalesCustomerOverviewSource = {
  totalMessages: 18,
  customerMessages: 7,
  staffReplies: 6,
  automatedMessages: 5,
  activeDays: 4,
  mediaMessages: 2,
  lastContactAt: '2026-09-10T11:30:00+09:00',
  lastCustomerMessageAt: '2026-09-10T11:30:00+09:00',
  lastStaffReplyAt: '2026-09-09T18:00:00+09:00',
  needsHumanReply: true,
  activeSupportCases: 1,
  supportCasesInPeriod: 2,
  lastSupportUpdatedAt: '2026-09-09T12:00:00+09:00',
  chatStatus: 'in_progress',
  isFollowing: true,
  topicCodes: ['payment', 'store_operations'],
};

describe('sales customer overview', () => {
  test('creates a substantial deterministic overview without assigning a status', () => {
    const overview = buildSalesCustomerOverview(source);

    expect(overview).toContain('顧客から7件');
    expect(overview).toContain('返信要否の確認が必要');
    expect(overview).toContain('対応中は1件');
    expect(overview).toContain('「決済・支払い」');
    expect(overview).toContain('「店舗・モール運用」');
    expect(overview).toContain('ステータスは会話確認後に人が設定');
    expect(overview).not.toMatch(/通常運用|要注意|クレーム対応中|退会手続き中|退会済み/);
  });

  test('explains an inactive case instead of leaving the overview blank', () => {
    const overview = buildSalesCustomerOverview({
      ...source,
      totalMessages: 0,
      customerMessages: 0,
      staffReplies: 0,
      automatedMessages: 0,
      activeDays: 0,
      lastContactAt: null,
      lastCustomerMessageAt: null,
      lastStaffReplyAt: null,
      needsHumanReply: false,
      activeSupportCases: 0,
      supportCasesInPeriod: 0,
      chatStatus: null,
      topicCodes: [],
    });

    expect(overview).toContain('直近90日間に対象となるLINEメッセージはありません');
    expect(overview).toContain('話題カテゴリはありません');
    expect(overview).toContain('人が設定');
  });

  test('uses stable normalized inputs for idempotency', () => {
    const first = salesCustomerOverviewFingerprintInput({
      ...source,
      topicCodes: ['store_operations', 'payment', 'payment'],
    });
    const second = salesCustomerOverviewFingerprintInput({
      ...source,
      topicCodes: ['payment', 'store_operations'],
    });

    expect(first).toBe(second);
  });
});
