import { getFriendByLineUserId, upsertFriend, jstNow } from '@line-crm/db';

type FollowerProfile = {
  displayName?: string | null;
  pictureUrl?: string | null;
  statusMessage?: string | null;
};

export type FollowerSyncClient = {
  getFollowers(options: { limit: number; start?: string }): Promise<{ userIds: string[]; next?: string }>;
  getProfile(userId: string): Promise<FollowerProfile>;
};

export type FollowerSyncPageResult = {
  fetched: number;
  created: number;
  updated: number;
  profileFailures: number;
  next: string | null;
};

const FOLLOWER_PAGE_SIZE = 200;
const PROFILE_CONCURRENCY = 20;

function uniqueLineUserIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(
    values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.length <= 128),
  ));
}

export async function syncFollowerPage(
  db: D1Database,
  client: FollowerSyncClient,
  lineAccountId: string,
  start?: string,
): Promise<FollowerSyncPageResult> {
  const page = await client.getFollowers({
    limit: FOLLOWER_PAGE_SIZE,
    ...(start ? { start } : {}),
  });
  const userIds = uniqueLineUserIds(page.userIds);
  let created = 0;
  let updated = 0;
  let profileFailures = 0;

  for (let offset = 0; offset < userIds.length; offset += PROFILE_CONCURRENCY) {
    const chunk = userIds.slice(offset, offset + PROFILE_CONCURRENCY);
    await Promise.all(chunk.map(async (lineUserId) => {
      const existing = await getFriendByLineUserId(db, lineUserId);
      let profile: FollowerProfile | null = null;
      try {
        profile = await client.getProfile(lineUserId);
      } catch {
        profileFailures += 1;
      }

      const friend = await upsertFriend(db, {
        lineUserId,
        ...(profile ? {
          displayName: profile.displayName ?? null,
          pictureUrl: profile.pictureUrl ?? null,
          statusMessage: profile.statusMessage ?? null,
        } : {}),
      });
      await db
        .prepare(
          `UPDATE friends
           SET line_account_id = ?, is_following = 1, updated_at = ?
           WHERE id = ?`,
        )
        .bind(lineAccountId, jstNow(), friend.id)
        .run();

      if (existing) updated += 1;
      else created += 1;
    }));
  }

  return {
    fetched: userIds.length,
    created,
    updated,
    profileFailures,
    next: typeof page.next === 'string' && page.next.trim() ? page.next.trim() : null,
  };
}
