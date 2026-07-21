import { describe, expect, test, vi } from 'vitest';
import { restoreSupportCasesFromCustomerMessage } from './support-case-customer-reply.js';

type CaseState = {
  id: string;
  friendId: string;
  lineAccountId: string | null;
  status: string;
};

type EventState = {
  id: string;
  caseId: string;
  eventType: string;
  metadata: string;
};

type MockStatement = D1PreparedStatement & {
  __sql: string;
  __binds: unknown[];
};

function makeDb(initialCases: CaseState[]) {
  const cases = initialCases.map((item) => ({ ...item }));
  const events: EventState[] = [];
  const batch = vi.fn(async (statements: D1PreparedStatement[]) => {
    const results: Array<{ success: true; meta: { changes: number } }> = [];

    for (const raw of statements) {
      const statement = raw as MockStatement;
      if (statement.__sql.includes('INSERT INTO support_case_events')) {
        const [id, , , metadata, , caseId, friendId, lineAccountId] = statement.__binds;
        const supportCase = cases.find((item) => item.id === caseId);
        const matches = supportCase?.friendId === friendId
          && supportCase.status === 'customer_reply'
          && supportCase.lineAccountId === (lineAccountId ?? null);
        if (matches) {
          if (events.some((event) => event.id === id)) throw new Error('UNIQUE constraint failed');
          events.push({
            id: String(id),
            caseId: String(caseId),
            eventType: 'customer_reply_received',
            metadata: String(metadata),
          });
        }
        results.push({ success: true, meta: { changes: matches ? 1 : 0 } });
        continue;
      }

      const [, caseId, friendId, lineAccountId] = statement.__binds;
      const supportCase = cases.find((item) => item.id === caseId);
      const matches = supportCase?.friendId === friendId
        && supportCase.status === 'customer_reply'
        && supportCase.lineAccountId === (lineAccountId ?? null);
      if (matches && supportCase) supportCase.status = 'waiting_primary';
      results.push({ success: true, meta: { changes: matches ? 1 : 0 } });
    }

    return results as D1Result<unknown>[];
  });

  const db = {
    prepare(sql: string) {
      const statement = {
        __sql: sql,
        __binds: [] as unknown[],
        bind(...values: unknown[]) {
          statement.__binds = values;
          return statement;
        },
        async all<T>() {
          const [friendId, lineAccountOrEventId, maybeEventId] = statement.__binds;
          const hasAccountScope = sql.includes('sc.line_account_id = ?');
          const lineAccountId = hasAccountScope ? lineAccountOrEventId : null;
          const sourceEventId = String(hasAccountScope ? maybeEventId : lineAccountOrEventId);
          const results = cases
            .filter((item) => item.friendId === friendId)
            .filter((item) => item.status === 'customer_reply')
            .filter((item) => item.lineAccountId === lineAccountId)
            .filter((item) => !events.some((event) => event.id === `customer-reply-received:${item.id}:${sourceEventId}`))
            .map((item) => ({ id: item.id } as T));
          return { results };
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    batch,
  } as unknown as D1Database;

  return { db, cases, events, batch };
}

describe('restoreSupportCasesFromCustomerMessage', () => {
  test('restores only matching customer_reply cases and records an audit event', async () => {
    const state = makeDb([
      { id: 'case-target', friendId: 'friend-1', lineAccountId: 'account-1', status: 'customer_reply' },
      { id: 'case-waiting', friendId: 'friend-1', lineAccountId: 'account-1', status: 'waiting_primary' },
      { id: 'case-resolved', friendId: 'friend-1', lineAccountId: 'account-1', status: 'resolved' },
      { id: 'case-other-account', friendId: 'friend-1', lineAccountId: 'account-2', status: 'customer_reply' },
      { id: 'case-other-friend', friendId: 'friend-2', lineAccountId: 'account-1', status: 'customer_reply' },
    ]);

    const result = await restoreSupportCasesFromCustomerMessage(state.db, {
      friendId: 'friend-1',
      lineAccountId: 'account-1',
      messageType: 'image',
      lineMessageId: 'line-message-1',
      webhookEventId: 'webhook-event-1',
      receivedAt: '2026-07-21T17:00:00.000+09:00',
    });

    expect(result).toEqual({ restored: 1, caseIds: ['case-target'] });
    expect(state.cases).toEqual([
      { id: 'case-target', friendId: 'friend-1', lineAccountId: 'account-1', status: 'waiting_primary' },
      { id: 'case-waiting', friendId: 'friend-1', lineAccountId: 'account-1', status: 'waiting_primary' },
      { id: 'case-resolved', friendId: 'friend-1', lineAccountId: 'account-1', status: 'resolved' },
      { id: 'case-other-account', friendId: 'friend-1', lineAccountId: 'account-2', status: 'customer_reply' },
      { id: 'case-other-friend', friendId: 'friend-2', lineAccountId: 'account-1', status: 'customer_reply' },
    ]);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      caseId: 'case-target',
      eventType: 'customer_reply_received',
    });
    expect(JSON.parse(state.events[0]!.metadata)).toMatchObject({
      messageType: 'image',
      lineMessageId: 'line-message-1',
      webhookEventId: 'webhook-event-1',
      previousStatus: 'customer_reply',
      nextStatus: 'waiting_primary',
    });
  });

  test('does not apply the same webhook event again after a later status change', async () => {
    const state = makeDb([
      { id: 'case-target', friendId: 'friend-1', lineAccountId: 'account-1', status: 'customer_reply' },
    ]);
    const params = {
      friendId: 'friend-1',
      lineAccountId: 'account-1',
      messageType: 'text',
      lineMessageId: 'line-message-1',
      webhookEventId: 'webhook-event-1',
      receivedAt: '2026-07-21T17:00:00.000+09:00',
    };

    await restoreSupportCasesFromCustomerMessage(state.db, params);
    state.cases[0]!.status = 'customer_reply';
    const repeated = await restoreSupportCasesFromCustomerMessage(state.db, params);

    expect(repeated).toEqual({ restored: 0, caseIds: [] });
    expect(state.cases[0]!.status).toBe('customer_reply');
    expect(state.events).toHaveLength(1);
    expect(state.batch).toHaveBeenCalledTimes(1);
  });
});
