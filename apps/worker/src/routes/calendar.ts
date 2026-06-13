import { Hono, type Context } from 'hono';
import {
  getCalendarConnections,
  getCalendarConnectionById,
  createCalendarConnection,
  deleteCalendarConnection,
  getCalendarBookingById,
  createCalendarBooking,
  updateCalendarBookingStatus,
  updateCalendarBookingEventId,
  getBookingsInRange,
  toJstString,
} from '@line-crm/db';
import { GoogleCalendarClient } from '../services/google-calendar.js';
import type { Env } from '../index.js';
import { supportFriendVisibilitySql } from '../services/support-access.js';
import { currentSupportStaff, ensureSupportFriendAccess } from './support-friend-access.js';
import { requireRole } from '../middleware/role-guard.js';

const calendar = new Hono<Env>();

const CALENDAR_ID_MAX_LENGTH = 256;
const CALENDAR_TOKEN_MAX_LENGTH = 4096;
const CALENDAR_TEXT_ID_MAX_LENGTH = 128;
const CALENDAR_TITLE_MAX_LENGTH = 160;
const CALENDAR_DESCRIPTION_MAX_LENGTH = 2048;
const CALENDAR_TIMESTAMP_MAX_LENGTH = 64;
const CALENDAR_METADATA_MAX_KEYS = 50;
const CALENDAR_METADATA_MAX_JSON_LENGTH = 16 * 1024;
const VISIBLE_ASCII_PATTERN = /^[!-~]+$/;
const CALENDAR_AUTH_TYPES = new Set(['api_key', 'oauth']);
const CALENDAR_BOOKING_STATUSES = new Set(['confirmed', 'cancelled', 'completed']);

interface CalendarBookingRow {
  id: string;
  connection_id: string;
  friend_id: string | null;
  event_id: string | null;
  title: string;
  start_at: string;
  end_at: string;
  status: string;
  metadata: string | null;
  created_at: string;
}

function clampInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) return fallback;
  return Math.floor(n);
}

type CalendarConnectionInput = {
  calendarId: string;
  authType: string;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
};

type CalendarBookingInput = {
  connectionId: string;
  friendId?: string;
  title: string;
  startAt: string;
  endAt: string;
  description?: string;
  metadata?: Record<string, unknown>;
};
type CalendarSlotsQuery = {
  connectionId: string;
  date: string;
  slotMinutes: number;
  startHour: number;
  endHour: number;
};
type CalendarBookingsQuery = {
  connectionId?: string;
  friendId?: string;
};

type ParseResult<T> = { ok: true; body: T } | { ok: false; error: string };
type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown | null> {
  return c.req.json().catch(() => null);
}

function parseRequiredString(
  raw: unknown,
  label: string,
  maxLength: number,
  asciiOnly = false,
): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: false, error: `${label} is required` };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  if (asciiOnly && !VISIBLE_ASCII_PATTERN.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseOptionalString(
  raw: unknown,
  label: string,
  maxLength: number,
  asciiOnly = false,
): ValueResult<string | undefined> {
  if (raw == null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `${label} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  if (value.length > maxLength) return { ok: false, error: `${label} is too long` };
  if (asciiOnly && !VISIBLE_ASCII_PATTERN.test(value)) return { ok: false, error: `${label} is invalid` };
  return { ok: true, value };
}

function parseCalendarPathId(raw: unknown, label: string): ValueResult<string> {
  return parseRequiredString(raw, label, CALENDAR_TEXT_ID_MAX_LENGTH, true);
}

function parseTimestamp(raw: unknown, label: string): ValueResult<string> {
  const parsed = parseRequiredString(raw, label, CALENDAR_TIMESTAMP_MAX_LENGTH);
  if (!parsed.ok) return parsed;
  if (!parsed.value.includes('T')) return { ok: false, error: `${label} must be a date-time string` };
  if (!Number.isFinite(new Date(parsed.value).getTime())) return { ok: false, error: `${label} is invalid` };
  return parsed;
}

function parseMetadata(raw: unknown): ValueResult<Record<string, unknown> | undefined> {
  if (raw == null) return { ok: true, value: undefined };
  if (!isRecord(raw)) return { ok: false, error: 'metadata must be an object' };
  if (Object.keys(raw).length > CALENDAR_METADATA_MAX_KEYS) {
    return { ok: false, error: 'metadata has too many keys' };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return { ok: false, error: 'metadata is invalid' };
  }
  if (serialized.length > CALENDAR_METADATA_MAX_JSON_LENGTH) {
    return { ok: false, error: 'metadata is too large' };
  }
  return { ok: true, value: raw };
}

function parseCalendarDateQuery(raw: unknown): ValueResult<string> {
  const parsed = parseRequiredString(raw, 'date', 10, true);
  if (!parsed.ok) return parsed;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.value)) {
    return { ok: false, error: 'date must be YYYY-MM-DD' };
  }
  const [year, month, day] = parsed.value.split('-').map(Number);
  const exactDate = new Date(Date.UTC(year, month - 1, day));
  if (
    exactDate.getUTCFullYear() !== year ||
    exactDate.getUTCMonth() !== month - 1 ||
    exactDate.getUTCDate() !== day
  ) {
    return { ok: false, error: 'date is invalid' };
  }
  return parsed;
}

function parseCalendarSlotsQuery(c: Context<Env>): ParseResult<CalendarSlotsQuery> {
  const connectionId = parseRequiredString(c.req.query('connectionId'), 'connectionId', CALENDAR_TEXT_ID_MAX_LENGTH, true);
  if (!connectionId.ok) return connectionId;
  const date = parseCalendarDateQuery(c.req.query('date'));
  if (!date.ok) return date;
  const slotMinutes = clampInteger(c.req.query('slotMinutes'), 60, 5, 480);
  const startHour = clampInteger(c.req.query('startHour'), 9, 0, 23);
  const endHour = clampInteger(c.req.query('endHour'), 18, 1, 24);
  if (startHour >= endHour) {
    return { ok: false, error: 'startHour must be before endHour' };
  }
  return { ok: true, body: { connectionId: connectionId.value, date: date.value, slotMinutes, startHour, endHour } };
}

function parseCalendarBookingsQuery(c: Context<Env>): ParseResult<CalendarBookingsQuery> {
  const connectionId = parseOptionalString(c.req.query('connectionId'), 'connectionId', CALENDAR_TEXT_ID_MAX_LENGTH, true);
  if (!connectionId.ok) return connectionId;
  const friendId = parseOptionalString(c.req.query('friendId'), 'friendId', CALENDAR_TEXT_ID_MAX_LENGTH, true);
  if (!friendId.ok) return friendId;
  return { ok: true, body: { connectionId: connectionId.value, friendId: friendId.value } };
}

function parseCalendarConnectionBody(raw: unknown): ParseResult<CalendarConnectionInput> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const calendarId = parseRequiredString(raw.calendarId, 'calendarId', CALENDAR_ID_MAX_LENGTH, true);
  if (!calendarId.ok) return calendarId;
  const authType = parseRequiredString(raw.authType, 'authType', 32, true);
  if (!authType.ok) return authType;
  if (!CALENDAR_AUTH_TYPES.has(authType.value)) return { ok: false, error: 'authType is invalid' };
  const accessToken = parseOptionalString(raw.accessToken, 'accessToken', CALENDAR_TOKEN_MAX_LENGTH, true);
  if (!accessToken.ok) return accessToken;
  const refreshToken = parseOptionalString(raw.refreshToken, 'refreshToken', CALENDAR_TOKEN_MAX_LENGTH, true);
  if (!refreshToken.ok) return refreshToken;
  const apiKey = parseOptionalString(raw.apiKey, 'apiKey', CALENDAR_TOKEN_MAX_LENGTH, true);
  if (!apiKey.ok) return apiKey;
  return {
    ok: true,
    body: {
      calendarId: calendarId.value,
      authType: authType.value,
      accessToken: accessToken.value,
      refreshToken: refreshToken.value,
      apiKey: apiKey.value,
    },
  };
}

function parseCalendarBookingBody(raw: unknown): ParseResult<CalendarBookingInput> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const connectionId = parseRequiredString(raw.connectionId, 'connectionId', CALENDAR_TEXT_ID_MAX_LENGTH, true);
  if (!connectionId.ok) return connectionId;
  const friendId = parseOptionalString(raw.friendId, 'friendId', CALENDAR_TEXT_ID_MAX_LENGTH, true);
  if (!friendId.ok) return friendId;
  const title = parseRequiredString(raw.title, 'title', CALENDAR_TITLE_MAX_LENGTH);
  if (!title.ok) return title;
  const startAt = parseTimestamp(raw.startAt, 'startAt');
  if (!startAt.ok) return startAt;
  const endAt = parseTimestamp(raw.endAt, 'endAt');
  if (!endAt.ok) return endAt;
  if (new Date(startAt.value).getTime() >= new Date(endAt.value).getTime()) {
    return { ok: false, error: 'startAt must be before endAt' };
  }
  const description = parseOptionalString(raw.description, 'description', CALENDAR_DESCRIPTION_MAX_LENGTH);
  if (!description.ok) return description;
  const metadata = parseMetadata(raw.metadata);
  if (!metadata.ok) return metadata;
  return {
    ok: true,
    body: {
      connectionId: connectionId.value,
      friendId: friendId.value,
      title: title.value,
      startAt: startAt.value,
      endAt: endAt.value,
      description: description.value,
      metadata: metadata.value,
    },
  };
}

function parseCalendarStatusBody(raw: unknown): ParseResult<{ status: string }> {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };
  const status = parseRequiredString(raw.status, 'status', 32, true);
  if (!status.ok) return status;
  if (!CALENDAR_BOOKING_STATUSES.has(status.value)) return { ok: false, error: 'status is invalid' };
  return { ok: true, body: { status: status.value } };
}

async function getScopedCalendarBookings(
  c: Context<Env>,
  opts: { connectionId?: string; friendId?: string } = {},
): Promise<CalendarBookingRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (opts.friendId) {
    conditions.push('cb.friend_id = ?');
    values.push(opts.friendId);
  }
  if (opts.connectionId) {
    conditions.push('cb.connection_id = ?');
    values.push(opts.connectionId);
  }

  const visibility = supportFriendVisibilitySql(currentSupportStaff(c), 'cb.friend_id');
  if (visibility.sql) {
    conditions.push(visibility.sql);
    values.push(...visibility.binds);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await c.env.DB
    .prepare(`SELECT cb.* FROM calendar_bookings cb ${where} ORDER BY cb.start_at ASC`)
    .bind(...values)
    .all<CalendarBookingRow>();
  return result.results;
}

// ========== 接続管理 ==========

calendar.get('/api/integrations/google-calendar', requireRole('owner', 'admin'), async (c) => {
  try {
    const items = await getCalendarConnections(c.env.DB);
    return c.json({
      success: true,
      data: items.map((conn) => ({
        id: conn.id,
        calendarId: conn.calendar_id,
        authType: conn.auth_type,
        isActive: Boolean(conn.is_active),
        createdAt: conn.created_at,
        updatedAt: conn.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/google-calendar error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

calendar.post('/api/integrations/google-calendar/connect', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseCalendarConnectionBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;
    const conn = await createCalendarConnection(c.env.DB, body);
    return c.json({
      success: true,
      data: { id: conn.id, calendarId: conn.calendar_id, authType: conn.auth_type, isActive: Boolean(conn.is_active), createdAt: conn.created_at },
    }, 201);
  } catch (err) {
    console.error('POST /api/integrations/google-calendar/connect error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

calendar.delete('/api/integrations/google-calendar/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseCalendarPathId(c.req.param('id'), 'connection_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    await deleteCalendarConnection(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/integrations/google-calendar/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 空きスロット取得 ==========

calendar.get('/api/integrations/google-calendar/slots', async (c) => {
  try {
    const parsed = parseCalendarSlotsQuery(c);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const { connectionId, date, slotMinutes, startHour, endHour } = parsed.body;

    const conn = await getCalendarConnectionById(c.env.DB, connectionId);
    if (!conn) {
      return c.json({ success: false, error: 'Calendar connection not found' }, 404);
    }

    const dayStart = `${date}T${String(startHour).padStart(2, '0')}:00:00`;
    const dayEnd = `${date}T${String(endHour).padStart(2, '0')}:00:00`;

    // 既存D1予約を取得
    const bookings = await getBookingsInRange(c.env.DB, connectionId, dayStart, dayEnd);

    // Google FreeBusy API から busy 区間を取得（access_token がある場合のみ）
    let googleBusyIntervals: { start: string; end: string }[] = [];
    if (conn.access_token) {
      try {
        const gcal = new GoogleCalendarClient({
          calendarId: conn.calendar_id,
          accessToken: conn.access_token,
        });
        // タイムゾーンオフセットを付けて ISO 形式で渡す（Asia/Tokyo = +09:00）
        const timeMin = `${date}T${String(startHour).padStart(2, '0')}:00:00+09:00`;
        const timeMax = `${date}T${String(endHour).padStart(2, '0')}:00:00+09:00`;
        googleBusyIntervals = await gcal.getFreeBusy(timeMin, timeMax);
      } catch (err) {
        // Google API 失敗はベストエフォート — D1 のみでフォールバック
        console.warn('Google FreeBusy API error (falling back to D1 only):', err);
      }
    }

    // スロットを生成して空きを計算
    const slots: { startAt: string; endAt: string; available: boolean }[] = [];
    const baseDate = new Date(`${date}T${String(startHour).padStart(2, '0')}:00:00+09:00`);

    for (let h = startHour; h < endHour; h += slotMinutes / 60) {
      const slotStart = new Date(baseDate);
      slotStart.setMinutes(slotStart.getMinutes() + (h - startHour) * 60);
      const slotEnd = new Date(slotStart);
      slotEnd.setMinutes(slotEnd.getMinutes() + slotMinutes);

      const startStr = toJstString(slotStart);
      const endStr = toJstString(slotEnd);

      // D1 予約との重複チェック
      const isBookedInD1 = bookings.some((b) => {
        const bStart = new Date(b.start_at).getTime();
        const bEnd = new Date(b.end_at).getTime();
        return slotStart.getTime() < bEnd && slotEnd.getTime() > bStart;
      });

      // Google busy 区間との重複チェック
      const isBookedInGoogle = googleBusyIntervals.some((interval) => {
        const gStart = new Date(interval.start).getTime();
        const gEnd = new Date(interval.end).getTime();
        return slotStart.getTime() < gEnd && slotEnd.getTime() > gStart;
      });

      slots.push({ startAt: startStr, endAt: endStr, available: !isBookedInD1 && !isBookedInGoogle });
    }

    return c.json({ success: true, data: slots });
  } catch (err) {
    console.error('GET /api/integrations/google-calendar/slots error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 予約管理 ==========

calendar.get('/api/integrations/google-calendar/bookings', async (c) => {
  try {
    const parsed = parseCalendarBookingsQuery(c);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const { connectionId, friendId } = parsed.body;
    if (friendId) {
      const denied = await ensureSupportFriendAccess(c, friendId);
      if (denied) return denied;
    }

    const items = await getScopedCalendarBookings(c, {
      connectionId,
      friendId,
    });
    return c.json({
      success: true,
      data: items.map((b) => ({
        id: b.id,
        connectionId: b.connection_id,
        friendId: b.friend_id,
        eventId: b.event_id,
        title: b.title,
        startAt: b.start_at,
        endAt: b.end_at,
        status: b.status,
        metadata: b.metadata ? JSON.parse(b.metadata) : null,
        createdAt: b.created_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/google-calendar/bookings error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

calendar.post('/api/integrations/google-calendar/book', async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseCalendarBookingBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    if (body.friendId) {
      const denied = await ensureSupportFriendAccess(c, body.friendId);
      if (denied) return denied;
    }

    // D1 に予約レコードを作成
    const booking = await createCalendarBooking(c.env.DB, {
      ...body,
      metadata: body.metadata ? JSON.stringify(body.metadata) : undefined,
    });

    // Google Calendar にイベントを作成（access_token がある場合のみ、ベストエフォート）
    const conn = await getCalendarConnectionById(c.env.DB, body.connectionId);
    if (conn?.access_token) {
      try {
        const gcal = new GoogleCalendarClient({
          calendarId: conn.calendar_id,
          accessToken: conn.access_token,
        });
        const { eventId } = await gcal.createEvent({
          summary: body.title,
          start: body.startAt,
          end: body.endAt,
          description: body.description,
        });
        // event_id を D1 予約レコードに保存
        await updateCalendarBookingEventId(c.env.DB, booking.id, eventId);
        booking.event_id = eventId;
      } catch (err) {
        // Google API 失敗はベストエフォート — D1 予約は維持する
        console.warn('Google Calendar createEvent error (booking still created in D1):', err);
      }
    }

    return c.json({
      success: true,
      data: {
        id: booking.id,
        connectionId: booking.connection_id,
        friendId: booking.friend_id,
        eventId: booking.event_id,
        title: booking.title,
        startAt: booking.start_at,
        endAt: booking.end_at,
        status: booking.status,
        createdAt: booking.created_at,
      },
    }, 201);
  } catch (err) {
    console.error('POST /api/integrations/google-calendar/book error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

calendar.put('/api/integrations/google-calendar/bookings/:id/status', async (c) => {
  try {
    const id = parseCalendarPathId(c.req.param('id'), 'booking_id');
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parseCalendarStatusBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const { status } = parsed.body;
    const booking = await getCalendarBookingById(c.env.DB, id.value);
    if (!booking) {
      return c.json({ success: false, error: 'Calendar booking not found' }, 404);
    }
    if (booking.friend_id) {
      const denied = await ensureSupportFriendAccess(c, booking.friend_id, 'Calendar booking not found');
      if (denied) return denied;
    }

    // キャンセル時は Google Calendar のイベントも削除する（ベストエフォート）
    if (status === 'cancelled') {
      if (booking?.event_id && booking.connection_id) {
        const conn = await getCalendarConnectionById(c.env.DB, booking.connection_id);
        if (conn?.access_token) {
          try {
            const gcal = new GoogleCalendarClient({
              calendarId: conn.calendar_id,
              accessToken: conn.access_token,
            });
            await gcal.deleteEvent(booking.event_id);
          } catch (err) {
            console.warn('Google Calendar deleteEvent error (status still updated in D1):', err);
          }
        }
      }
    }

    await updateCalendarBookingStatus(c.env.DB, id.value, status);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('PUT /api/integrations/google-calendar/bookings/:id/status error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { calendar };
