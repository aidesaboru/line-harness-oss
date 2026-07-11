export const LINE_SAFETY_SETTING_KEY = 'line_safety_freeze';

const LINE_SAFETY_REASON_MAX_LENGTH = 500;
const LINE_SAFETY_UPDATED_BY_MAX_LENGTH = 160;

export type LineSafetyMode = {
  frozen: boolean;
  reason: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type LineSendSafetyBlock = LineSafetyMode & {
  accountId: string;
  message: string;
};

export class LineSafetyBlockedError extends Error {
  readonly code = 'LINE_SAFETY_FROZEN';
  readonly block: LineSendSafetyBlock;

  constructor(block: LineSendSafetyBlock) {
    super(block.message);
    this.name = 'LineSafetyBlockedError';
    this.block = block;
  }
}

function emptyLineSafetyMode(): LineSafetyMode {
  return {
    frozen: false,
    reason: null,
    updatedAt: null,
    updatedBy: null,
  };
}

function jstIsoNow(): string {
  return new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
}

function cleanOptionalText(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  return value.slice(0, maxLength);
}

export function parseLineSafetySetting(raw: string | null | undefined, fallbackUpdatedAt?: string | null): LineSafetyMode {
  if (!raw) return emptyLineSafetyMode();

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === true) {
      return {
        frozen: true,
        reason: null,
        updatedAt: fallbackUpdatedAt ?? null,
        updatedBy: null,
      };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return emptyLineSafetyMode();
    }
    const row = parsed as Record<string, unknown>;
    return {
      frozen: row.frozen === true,
      reason: cleanOptionalText(row.reason, LINE_SAFETY_REASON_MAX_LENGTH),
      updatedAt: cleanOptionalText(row.updatedAt, 80) ?? fallbackUpdatedAt ?? null,
      updatedBy: cleanOptionalText(row.updatedBy, LINE_SAFETY_UPDATED_BY_MAX_LENGTH),
    };
  } catch {
    const legacy = raw.trim().toLowerCase();
    if (legacy === '1' || legacy === 'true' || legacy === 'yes' || legacy === 'on') {
      return {
        frozen: true,
        reason: null,
        updatedAt: fallbackUpdatedAt ?? null,
        updatedBy: null,
      };
    }
    return emptyLineSafetyMode();
  }
}

export function lineSafetyBlockedMessage(mode: Pick<LineSafetyMode, 'reason'>): string {
  return mode.reason
    ? `LINE送信セーフティ停止中です: ${mode.reason}`
    : 'LINE送信セーフティ停止中です。緊急コントロールで解除するまで送信できません。';
}

export async function getLineSafetyMode(
  db: D1Database,
  accountId: string | null | undefined,
): Promise<LineSafetyMode> {
  if (!accountId) return emptyLineSafetyMode();

  const row = await db
    .prepare(`SELECT value, updated_at FROM account_settings WHERE line_account_id = ? AND key = ?`)
    .bind(accountId, LINE_SAFETY_SETTING_KEY)
    .first<{ value: string; updated_at: string | null }>();

  return parseLineSafetySetting(row?.value, row?.updated_at ?? null);
}

export async function setLineSafetyMode(
  db: D1Database,
  accountId: string,
  input: { frozen: boolean; reason?: string | null; updatedBy?: string | null },
): Promise<LineSafetyMode> {
  const now = jstIsoNow();
  const mode: LineSafetyMode = {
    frozen: input.frozen,
    reason: cleanOptionalText(input.reason, LINE_SAFETY_REASON_MAX_LENGTH),
    updatedAt: now,
    updatedBy: cleanOptionalText(input.updatedBy, LINE_SAFETY_UPDATED_BY_MAX_LENGTH),
  };
  const value = JSON.stringify(mode);

  await db
    .prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?`,
    )
    .bind(
      crypto.randomUUID(),
      accountId,
      LINE_SAFETY_SETTING_KEY,
      value,
      now,
      now,
      value,
      now,
    )
    .run();

  return mode;
}

export async function getLineSendSafetyBlock(
  db: D1Database,
  accountId: string | null | undefined,
): Promise<LineSendSafetyBlock | null> {
  if (!accountId) return null;
  const mode = await getLineSafetyMode(db, accountId);
  if (!mode.frozen) return null;
  return {
    ...mode,
    accountId,
    message: lineSafetyBlockedMessage(mode),
  };
}

export async function assertLineSendAllowed(
  db: D1Database,
  accountId: string | null | undefined,
): Promise<void> {
  const block = await getLineSendSafetyBlock(db, accountId);
  if (block) throw new LineSafetyBlockedError(block);
}

export function isLineSafetyBlockedError(err: unknown): err is LineSafetyBlockedError {
  return err instanceof LineSafetyBlockedError;
}

export async function getFrozenLineAccountIds(
  db: D1Database,
  accountIds: Array<string | null | undefined>,
): Promise<LineSendSafetyBlock[]> {
  const unique = [...new Set(accountIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const blocks: LineSendSafetyBlock[] = [];
  for (const accountId of unique) {
    const block = await getLineSendSafetyBlock(db, accountId);
    if (block) blocks.push(block);
  }
  return blocks;
}
