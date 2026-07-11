import type { SupportAccessStaff } from './support-access.js';

export const INTERNAL_MESSAGE_REACTION_EMOJIS = ['👍', '🙏', '✅', '👀', '❤️'] as const;

export type InternalMessageReactionSummary = {
  emoji: string;
  count: number;
  reactedByMe: boolean;
  names: string[];
};

type StoredReactionUser = {
  id: string;
  name: string;
};

type StoredReactions = Record<string, StoredReactionUser[]>;

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

const allowedReactionSet = new Set<string>(INTERNAL_MESSAGE_REACTION_EMOJIS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeInternalReactionEmoji(raw: unknown): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'emoji must be a string' };
  const emoji = raw.trim();
  if (!allowedReactionSet.has(emoji)) return { ok: false, error: 'emoji is not allowed' };
  return { ok: true, value: emoji };
}

function parseStoredInternalReactions(raw: string | null | undefined): StoredReactions {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    const reactions: StoredReactions = {};
    for (const [emoji, users] of Object.entries(parsed)) {
      if (!allowedReactionSet.has(emoji) || !Array.isArray(users)) continue;
      const normalizedUsers: StoredReactionUser[] = [];
      const seen = new Set<string>();
      for (const user of users) {
        if (!isRecord(user) || typeof user.id !== 'string') continue;
        const id = user.id.trim();
        if (!id || seen.has(id)) continue;
        const name = typeof user.name === 'string' && user.name.trim() ? user.name.trim() : id;
        seen.add(id);
        normalizedUsers.push({ id, name });
      }
      if (normalizedUsers.length > 0) reactions[emoji] = normalizedUsers;
    }
    return reactions;
  } catch {
    return {};
  }
}

function reactionOrder(emoji: string): number {
  const index = INTERNAL_MESSAGE_REACTION_EMOJIS.findIndex((item) => item === emoji);
  return index === -1 ? INTERNAL_MESSAGE_REACTION_EMOJIS.length : index;
}

export function summarizeInternalReactions(
  raw: string | null | undefined,
  staff: SupportAccessStaff,
): InternalMessageReactionSummary[] {
  const stored = parseStoredInternalReactions(raw);
  return Object.entries(stored)
    .sort(([a], [b]) => reactionOrder(a) - reactionOrder(b))
    .map(([emoji, users]) => ({
      emoji,
      count: users.length,
      reactedByMe: users.some((user) => user.id === staff.id),
      names: users.map((user) => user.name),
    }));
}

export function toggleInternalReaction(
  raw: string | null | undefined,
  emoji: string,
  staff: SupportAccessStaff,
): { reactionsJson: string } {
  const stored = parseStoredInternalReactions(raw);
  const users = stored[emoji] ?? [];
  const existingIndex = users.findIndex((user) => user.id === staff.id);
  if (existingIndex >= 0) {
    users.splice(existingIndex, 1);
  } else {
    users.push({ id: staff.id, name: staff.name || staff.id });
  }
  if (users.length > 0) {
    stored[emoji] = users;
  } else {
    delete stored[emoji];
  }
  return { reactionsJson: JSON.stringify(stored) };
}
