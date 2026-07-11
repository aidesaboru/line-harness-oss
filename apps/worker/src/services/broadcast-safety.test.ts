import { describe, expect, it } from 'vitest';
import { appendBroadcastSafetyFilter, broadcastSafetyWhere } from './broadcast-safety.js';

describe('broadcast safety filters', () => {
  it('excludes unfollowed, active support, active chat, and opt-out metadata friends', () => {
    const where = broadcastSafetyWhere('f');

    expect(where).toContain('COALESCE(f.is_following, 0) = 1');
    expect(where).toContain('FROM support_cases sc_broadcast_scope');
    expect(where).toContain("sc_broadcast_scope.status != 'resolved'");
    expect(where).toContain('FROM chats ch_broadcast_scope');
    expect(where).toContain("ch_broadcast_scope.status IN ('unread', 'in_progress')");
    expect(where).toContain("$.broadcastExcluded");
    expect(where).toContain("$.do_not_broadcast");
    expect(where).toContain("$.send_paused");
    expect(where).toContain("$.deliveryStopped");
  });

  it('inserts the shared filter into segment SQL without adding bind parameters', () => {
    const sql = appendBroadcastSafetyFilter(
      'SELECT f.id, f.line_user_id FROM friends f WHERE EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)',
    );

    expect(sql).toMatch(/^SELECT f\.id, f\.line_user_id FROM friends f WHERE COALESCE\(f\.is_following, 0\) = 1/);
    expect(sql).toContain('AND EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)');
  });
});
