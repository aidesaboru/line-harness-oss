import { Hono, type Context } from 'hono';
import { LineClient } from '@line-crm/line-sdk';
import { getFriendById, getLineAccountById } from '@line-crm/db';
import type { Env } from '../index.js';
import { ensureSupportFriendAccess } from './support-friend-access.js';
import { requireRole } from '../middleware/role-guard.js';

const richMenus = new Hono<Env>();

const RICH_MENU_ID_MAX_LENGTH = 128;
const RICH_MENU_TEXT_MAX_LENGTH = 300;
const RICH_MENU_CREATE_MAX_BYTES = 50000;
const RICH_MENU_IMAGE_MAX_BYTES = 1024 * 1024;
const RICH_MENU_VISIBLE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };
type RichMenuCreateBody = Parameters<LineClient['createRichMenu']>[0];

richMenus.use('/api/rich-menus', requireRole('owner', 'admin'));
richMenus.use('/api/rich-menus/*', requireRole('owner', 'admin'));

async function readJsonObject(c: Context<Env>): Promise<ValueResult<Record<string, unknown>>> {
  try {
    const body = await c.req.json<unknown>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, error: 'invalid_payload' };
    }
    return { ok: true, value: body as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseVisibleId(raw: unknown, label: string): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value || value.length > RICH_MENU_ID_MAX_LENGTH || !RICH_MENU_VISIBLE_ID_PATTERN.test(value)) {
    return { ok: false, error: `invalid_${label}` };
  }
  return { ok: true, value };
}

function parseOptionalVisibleId(raw: unknown, label: string): ValueResult<string | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  return parseVisibleId(raw, label);
}

function parseOptionalText(raw: unknown, label: string): ValueResult<string | undefined> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `invalid_${label}` };
  const value = raw.trim();
  if (!value || value.length > RICH_MENU_TEXT_MAX_LENGTH) return { ok: false, error: `invalid_${label}` };
  return { ok: true, value };
}

function parseRequiredText(raw: unknown, label: string): ValueResult<string> {
  const value = parseOptionalText(raw, label);
  if (!value.ok) return value;
  if (value.value === undefined) return { ok: false, error: `invalid_${label}` };
  return { ok: true, value: value.value };
}

function parseRichMenuSize(raw: unknown): ValueResult<{ width: number; height: number }> {
  if (!isRecord(raw)) return { ok: false, error: 'invalid_size' };
  const width = raw.width;
  const height = raw.height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    (width as number) <= 0 ||
    (height as number) <= 0 ||
    (width as number) > 2500 ||
    (height as number) > 2500
  ) {
    return { ok: false, error: 'invalid_size' };
  }
  return { ok: true, value: { width: width as number, height: height as number } };
}

function parseRichMenuAreas(raw: unknown): ValueResult<RichMenuCreateBody['areas']> {
  if (!Array.isArray(raw) || raw.length > 20) return { ok: false, error: 'invalid_areas' };
  for (const area of raw) {
    if (!isRecord(area) || !isRecord(area.bounds) || !isRecord(area.action)) {
      return { ok: false, error: 'invalid_areas' };
    }
    for (const key of ['x', 'y', 'width', 'height']) {
      const value = area.bounds[key];
      if (!Number.isInteger(value) || (value as number) < 0 || (key !== 'x' && key !== 'y' && (value as number) === 0)) {
        return { ok: false, error: 'invalid_areas' };
      }
    }
    if (typeof area.action.type !== 'string' || !area.action.type.trim()) {
      return { ok: false, error: 'invalid_areas' };
    }
  }
  return { ok: true, value: raw as RichMenuCreateBody['areas'] };
}

function parseRichMenuCreateBody(raw: Record<string, unknown>): ValueResult<RichMenuCreateBody> {
  if (JSON.stringify(raw).length > RICH_MENU_CREATE_MAX_BYTES) {
    return { ok: false, error: 'invalid_payload' };
  }
  const name = parseRequiredText(raw.name, 'name');
  if (!name.ok) return { ok: false, error: name.error };
  const chatBarText = parseRequiredText(raw.chatBarText, 'chat_bar_text');
  if (!chatBarText.ok) return { ok: false, error: chatBarText.error };
  if (typeof raw.selected !== 'boolean') {
    return { ok: false, error: 'invalid_selected' };
  }
  const size = parseRichMenuSize(raw.size);
  if (!size.ok) return { ok: false, error: size.error };
  const areas = parseRichMenuAreas(raw.areas);
  if (!areas.ok) return { ok: false, error: areas.error };
  const normalized = {
    ...raw,
    size: size.value,
    selected: raw.selected,
    name: name.value,
    chatBarText: chatBarText.value,
    areas: areas.value,
  } as RichMenuCreateBody;
  return { ok: true, value: normalized };
}

function decodeBase64Image(raw: unknown): ValueResult<ArrayBuffer> {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_image' };
  const value = raw.trim();
  if (!value) return { ok: false, error: 'invalid_image' };
  const base64 = value.replace(/^data:image\/(?:png|jpeg|jpg);base64,/, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    return { ok: false, error: 'invalid_image' };
  }
  try {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    if (bytes.byteLength === 0 || bytes.byteLength > RICH_MENU_IMAGE_MAX_BYTES) {
      return { ok: false, error: 'invalid_image' };
    }
    return { ok: true, value: bytes.buffer };
  } catch {
    return { ok: false, error: 'invalid_image' };
  }
}

function parseImageContentType(raw: unknown): ValueResult<'image/png' | 'image/jpeg'> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 'image/png' };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_content_type' };
  const value = raw.trim();
  if (value === 'image/png' || value === 'image/jpeg') return { ok: true, value };
  return { ok: false, error: 'invalid_content_type' };
}

function richMenuRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

function richMenuRouteErrorIncludes(err: unknown, fragment: string): boolean {
  if (err instanceof Error) return err.message.includes(fragment);
  return typeof err === 'string' && err.includes(fragment);
}

/** Resolve LINE access token — uses accountId query param if provided, otherwise default */
async function resolveLineClient(c: Context<Env>): Promise<ValueResult<LineClient>> {
  const accountId = parseOptionalVisibleId(c.req.query('accountId'), 'account_id');
  if (!accountId.ok) return { ok: false, error: accountId.error };
  if (accountId.value) {
    const account = await getLineAccountById(c.env.DB, accountId.value);
    if (account) return { ok: true, value: new LineClient(account.channel_access_token) };
  }
  return { ok: true, value: new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN) };
}

// GET /api/rich-menus — list all rich menus from LINE API
richMenus.get('/api/rich-menus', async (c) => {
  try {
    const lineClient = await resolveLineClient(c);
    if (!lineClient.ok) return c.json({ success: false, error: lineClient.error }, 400);
    const result = await lineClient.value.getRichMenuList();
    return c.json({ success: true, data: result.richmenus ?? [] });
  } catch (err) {
    console.error(`GET /api/rich-menus error: ${richMenuRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/rich-menus — create a rich menu via LINE API
richMenus.post('/api/rich-menus', async (c) => {
  try {
    const rawBody = await readJsonObject(c);
    if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);
    const body = parseRichMenuCreateBody(rawBody.value);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    const lineClient = await resolveLineClient(c);
    if (!lineClient.ok) return c.json({ success: false, error: lineClient.error }, 400);
    const result = await lineClient.value.createRichMenu(body.value);
    return c.json({ success: true, data: result }, 201);
  } catch (err) {
    console.error(`POST /api/rich-menus error: ${richMenuRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/rich-menus/:id — delete a rich menu
richMenus.delete('/api/rich-menus/:id', async (c) => {
  try {
    const richMenuId = parseVisibleId(c.req.param('id'), 'rich_menu_id');
    if (!richMenuId.ok) return c.json({ success: false, error: richMenuId.error }, 400);
    const lineClient = await resolveLineClient(c);
    if (!lineClient.ok) return c.json({ success: false, error: lineClient.error }, 400);
    await lineClient.value.deleteRichMenu(richMenuId.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/rich-menus/:id error: ${richMenuRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/rich-menus/:id/default — set rich menu as default for all users
richMenus.post('/api/rich-menus/:id/default', async (c) => {
  try {
    const richMenuId = parseVisibleId(c.req.param('id'), 'rich_menu_id');
    if (!richMenuId.ok) return c.json({ success: false, error: richMenuId.error }, 400);
    const lineClient = await resolveLineClient(c);
    if (!lineClient.ok) return c.json({ success: false, error: lineClient.error }, 400);
    await lineClient.value.setDefaultRichMenu(richMenuId.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`POST /api/rich-menus/:id/default error: ${richMenuRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/friends/:friendId/rich-menu — link rich menu to a specific friend
richMenus.post('/api/friends/:friendId/rich-menu', async (c) => {
  try {
    const friendId = parseVisibleId(c.req.param('friendId'), 'friend_id');
    if (!friendId.ok) return c.json({ success: false, error: friendId.error }, 400);
    const body = await readJsonObject(c);
    if (!body.ok) return c.json({ success: false, error: body.error }, 400);
    const richMenuId = parseVisibleId(body.value.richMenuId, 'rich_menu_id');
    if (!richMenuId.ok) return c.json({ success: false, error: richMenuId.error }, 400);
    const denied = await ensureSupportFriendAccess(c, friendId.value);
    if (denied) return denied;

    const db = c.env.DB;
    const friend = await getFriendById(db, friendId.value);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    const friendAccountId = (friend as unknown as Record<string, string | null>).line_account_id;
    if (friendAccountId) {
      const account = await getLineAccountById(db, friendAccountId);
      if (account) accessToken = account.channel_access_token;
    }
    const lineClient = new LineClient(accessToken);
    await lineClient.linkRichMenuToUser(friend.line_user_id, richMenuId.value);

    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`POST /api/friends/:friendId/rich-menu error: ${richMenuRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/friends/:friendId/rich-menu — unlink rich menu from a specific friend
richMenus.delete('/api/friends/:friendId/rich-menu', async (c) => {
  try {
    const friendId = parseVisibleId(c.req.param('friendId'), 'friend_id');
    if (!friendId.ok) return c.json({ success: false, error: friendId.error }, 400);
    const denied = await ensureSupportFriendAccess(c, friendId.value);
    if (denied) return denied;
    const db = c.env.DB;

    const friend = await getFriendById(db, friendId.value);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    const friendAccId = (friend as unknown as Record<string, string | null>).line_account_id;
    if (friendAccId) {
      const account = await getLineAccountById(c.env.DB, friendAccId);
      if (account) accessToken = account.channel_access_token;
    }
    const lineClient = new LineClient(accessToken);
    await lineClient.unlinkRichMenuFromUser(friend.line_user_id);

    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/friends/:friendId/rich-menu error: ${richMenuRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/friends/:friendId/rich-menu — get rich menu currently linked to a friend
richMenus.get('/api/friends/:friendId/rich-menu', async (c) => {
  try {
    const friendId = parseVisibleId(c.req.param('friendId'), 'friend_id');
    if (!friendId.ok) return c.json({ success: false, error: friendId.error }, 400);
    const denied = await ensureSupportFriendAccess(c, friendId.value);
    if (denied) return denied;
    const db = c.env.DB;

    const friend = await getFriendById(db, friendId.value);
    if (!friend) {
      return c.json({ success: false, error: 'Friend not found' }, 404);
    }

    let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
    const friendAccId = (friend as unknown as Record<string, string | null>).line_account_id;
    if (friendAccId) {
      const account = await getLineAccountById(db, friendAccId);
      if (account) accessToken = account.channel_access_token;
    }
    const lineClient = new LineClient(accessToken);

    // 個別メニュー取得 — 404 (個別未設定) のみ null に正規化。トークン期限切れ
    // / 5xx 等の真のエラーは外側 catch に伝搬させて 500 を返す。null と「取得失敗」
    // を混同すると運用者にデフォルトメニューが偽表示される。
    let userMenuId: string | null = null;
    try {
      const r = await lineClient.getRichMenuIdOfUser(friend.line_user_id);
      userMenuId = r.richMenuId;
    } catch (err) {
      if (richMenuRouteErrorIncludes(err, '404')) {
        userMenuId = null;
      } else {
        throw err;
      }
    }

    // 個別未設定ならデフォルトを fallback。getDefaultRichMenuId は client.ts 側で
    // 404 を null に変換済 (Task 1)、その他のエラーは throw され外側 catch に流れる。
    let isDefault = false;
    let effectiveId: string | null = userMenuId;
    if (!userMenuId) {
      effectiveId = await lineClient.getDefaultRichMenuId();
      isDefault = !!effectiveId;
    }

    // メニュー名は LINE API のリストから lookup (rich_menus DB テーブルは無い)
    let name: string | null = null;
    if (effectiveId) {
      try {
        const list = await lineClient.getRichMenuList();
        const found = (list.richmenus ?? []).find((m) => m.richMenuId === effectiveId);
        name = found?.name ?? null;
      } catch {
        // silent — 名前は出せないが id だけは返す
      }
    }

    return c.json({
      success: true,
      data: { id: effectiveId, name, isDefault },
    });
  } catch (err) {
    console.error(`GET /api/friends/:friendId/rich-menu error: ${richMenuRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { richMenus };

// POST /api/rich-menus/:id/image — upload rich menu image (accepts base64 body or binary)
richMenus.post('/api/rich-menus/:id/image', async (c) => {
  try {
    const richMenuId = parseVisibleId(c.req.param('id'), 'rich_menu_id');
    if (!richMenuId.ok) return c.json({ success: false, error: richMenuId.error }, 400);
    const contentType = c.req.header('content-type') ?? '';

    let imageData: ArrayBuffer;
    let imageContentType: 'image/png' | 'image/jpeg' = 'image/png';

    if (contentType.includes('application/json')) {
      const body = await readJsonObject(c);
      if (!body.ok) return c.json({ success: false, error: body.error }, 400);
      const decoded = decodeBase64Image(body.value.image);
      if (!decoded.ok) return c.json({ success: false, error: decoded.error }, 400);
      const parsedContentType = parseImageContentType(body.value.contentType);
      if (!parsedContentType.ok) return c.json({ success: false, error: parsedContentType.error }, 400);
      imageData = decoded.value;
      imageContentType = parsedContentType.value;
    } else if (contentType.includes('image/')) {
      if (!contentType.includes('image/png') && !contentType.includes('image/jpeg') && !contentType.includes('image/jpg')) {
        return c.json({ success: false, error: 'invalid_content_type' }, 400);
      }
      imageData = await c.req.arrayBuffer();
      if (imageData.byteLength === 0 || imageData.byteLength > RICH_MENU_IMAGE_MAX_BYTES) {
        return c.json({ success: false, error: 'invalid_image' }, 400);
      }
      imageContentType = contentType.includes('jpeg') || contentType.includes('jpg') ? 'image/jpeg' : 'image/png';
    } else {
      return c.json({ success: false, error: 'Content-Type must be application/json (with base64) or image/png or image/jpeg' }, 400);
    }

    const lineClient = await resolveLineClient(c);
    if (!lineClient.ok) return c.json({ success: false, error: lineClient.error }, 400);
    await lineClient.value.uploadRichMenuImage(richMenuId.value, imageData, imageContentType);

    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`POST /api/rich-menus/:id/image error: ${richMenuRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
