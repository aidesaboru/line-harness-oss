import { describe, expect, test } from 'vitest';
import {
  mentionTargetsMatchBody,
  parseMentionStaffIds,
} from './internal-message-mentions.js';

describe('internal message mentions', () => {
  test('deduplicates stable staff IDs without changing order', () => {
    expect(parseMentionStaffIds(['staff-2', 'staff-1', 'staff-2'])).toEqual({
      ok: true,
      value: ['staff-2', 'staff-1'],
    });
  });

  test('rejects invalid IDs and oversized mention lists', () => {
    expect(parseMentionStaffIds(['staff id'])).toEqual({
      ok: false,
      error: 'mentionStaffId is invalid',
    });
    expect(parseMentionStaffIds(['staff-1', 'staff-2'], 1)).toEqual({
      ok: false,
      error: 'mentionStaffIds is too long',
    });
  });

  test('requires every stable target to appear in the message body', () => {
    const targets = [
      { id: 'staff-1', name: '宮本 森一' },
      { id: 'staff-2', name: '梶原 麻奈美' },
    ];
    expect(mentionTargetsMatchBody('@宮本 森一 @梶原 麻奈美 ご確認ください', targets)).toBe(true);
    expect(mentionTargetsMatchBody('@宮本 森一 ご確認ください', targets)).toBe(false);
  });
});
