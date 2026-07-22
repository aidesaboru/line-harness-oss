import { describe, expect, test } from 'vitest';
import {
  internalMessagePermissions,
  parseInternalMessageEventArray,
  projectInternalMessage,
  type InternalMessageEventRow,
} from './internal-message-events.js';

const baseEvent: InternalMessageEventRow = {
  id: 'event-1',
  source_type: 'chat',
  source_message_id: 'message-1',
  version: 1,
  action: 'edit',
  body: '修正後の本文',
  mentions: '["田島"]',
  mention_staff_ids: '["staff-2"]',
  reason: null,
  actor_id: 'staff-1',
  actor_name: '投稿者',
  created_at: '2026-07-22T16:30:00.000',
};

describe('internal message event projection', () => {
  test('accepts only string values from stored JSON arrays', () => {
    expect(parseInternalMessageEventArray('["田島",1,null,"松山"]')).toEqual(['田島', '松山']);
    expect(parseInternalMessageEventArray('broken')).toEqual([]);
  });

  test('allows authors to edit and admins to delete without granting others', () => {
    const message = { created_by: 'staff-1' };

    expect(internalMessagePermissions(message, undefined, { id: 'staff-1', name: '投稿者', role: 'staff' }))
      .toEqual({ canEdit: true, canDelete: true });
    expect(internalMessagePermissions(message, undefined, { id: 'admin-1', name: '管理者', role: 'admin' }))
      .toEqual({ canEdit: false, canDelete: true });
    expect(internalMessagePermissions(message, undefined, { id: 'staff-2', name: '他担当', role: 'staff' }))
      .toEqual({ canEdit: false, canDelete: false });
  });

  test('projects the latest edit and locks a deleted message', () => {
    const message = { body: '元の本文', mentions: '[]', created_by: 'staff-1' };
    const staff = { id: 'staff-1', name: '投稿者', role: 'staff' as const };
    const edited = projectInternalMessage(message, baseEvent, staff);

    expect(edited).toMatchObject({
      body: '修正後の本文',
      mentions: ['田島'],
      mentionStaffIds: ['staff-2'],
      version: 1,
      isDeleted: false,
      canEdit: true,
    });

    const deleted = projectInternalMessage(
      message,
      { ...baseEvent, version: 2, action: 'delete', body: null, actor_name: '管理者' },
      staff,
    );
    expect(deleted).toMatchObject({
      body: 'このメッセージは削除されました',
      mentions: [],
      mentionStaffIds: [],
      version: 2,
      isDeleted: true,
      deletedByName: '管理者',
      canEdit: false,
      canDelete: false,
    });
  });
});
