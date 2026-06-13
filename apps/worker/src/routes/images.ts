import { Hono, type Context } from 'hono';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const images = new Hono<Env>();

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_KEY_MAX_LENGTH = 256;
const IMAGE_FILENAME_MAX_LENGTH = 255;
const IMAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IMAGE_FILENAME_PATTERN = /^[^\u0000-\u001F\u007F/\\]+$/;
const IMAGE_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

type ImageMimeType = (typeof ALLOWED_IMAGE_TYPES)[number];
type ValueResult<T> = { ok: true; value: T } | { ok: false; error: string };

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

function parseImageMimeType(raw: unknown): ValueResult<ImageMimeType> {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_mime_type' };
  const mimeType = raw.split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(mimeType as ImageMimeType)) {
    return { ok: false, error: `Unsupported image type: ${mimeType}. Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}` };
  }
  return { ok: true, value: mimeType as ImageMimeType };
}

function parseOptionalFilename(raw: unknown): ValueResult<string | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_filename' };
  const filename = raw.trim();
  if (!filename) return { ok: true, value: undefined };
  if (filename.length > IMAGE_FILENAME_MAX_LENGTH || !IMAGE_FILENAME_PATTERN.test(filename)) {
    return { ok: false, error: 'invalid_filename' };
  }
  return { ok: true, value: filename };
}

function parseImageKey(raw: unknown): ValueResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: 'invalid_key' };
  const key = raw.trim();
  if (!key || key.length > IMAGE_KEY_MAX_LENGTH || !IMAGE_KEY_PATTERN.test(key)) {
    return { ok: false, error: 'invalid_key' };
  }
  return { ok: true, value: key };
}

function decodeBase64Image(raw: unknown): ValueResult<ArrayBuffer> {
  if (typeof raw !== 'string') return { ok: false, error: 'data (base64) is required' };
  const base64 = raw.replace(/\s+/g, '');
  if (!base64 || !IMAGE_BASE64_PATTERN.test(base64)) {
    return { ok: false, error: 'invalid_base64' };
  }
  try {
    const binary = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    return binary.byteLength > 0 ? { ok: true, value: binary.buffer } : { ok: false, error: 'invalid_base64' };
  } catch {
    return { ok: false, error: 'invalid_base64' };
  }
}

function imageRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

// POST /api/images — upload image (base64 or binary)
images.post('/api/images', async (c) => {
  try {
    const contentType = c.req.header('Content-Type') || '';

    let data: ArrayBuffer;
    let mimeType: string;
    let filename: string | undefined;

    if (contentType.includes('application/json')) {
      const rawBody = await readJsonObject(c);
      if (!rawBody.ok) return c.json({ success: false, error: rawBody.error }, 400);

      let rawData = rawBody.value.data;
      let parsedMime = parseImageMimeType(rawBody.value.mimeType ?? 'image/png');
      if (typeof rawData === 'string' && rawData.startsWith('data:')) {
        const match = rawData.match(/^data:([^;,]+);base64,(.+)$/i);
        if (!match) return c.json({ success: false, error: 'invalid_data_uri' }, 400);
        parsedMime = parseImageMimeType(match[1]);
        rawData = match[2];
      }
      if (!parsedMime.ok) return c.json({ success: false, error: parsedMime.error }, 400);
      mimeType = parsedMime.value;

      const parsedFilename = parseOptionalFilename(rawBody.value.filename);
      if (!parsedFilename.ok) return c.json({ success: false, error: parsedFilename.error }, 400);
      filename = parsedFilename.value;

      const decoded = decodeBase64Image(rawData);
      if (!decoded.ok) return c.json({ success: false, error: decoded.error }, 400);
      data = decoded.value;
    } else {
      data = await c.req.arrayBuffer();
      const parsedMime = parseImageMimeType(contentType || 'image/png');
      if (!parsedMime.ok) return c.json({ success: false, error: parsedMime.error }, 400);
      mimeType = parsedMime.value;
    }

    if (data.byteLength === 0) {
      return c.json({ success: false, error: 'Image data is required' }, 400);
    }

    if (data.byteLength > IMAGE_MAX_BYTES) {
      return c.json({ success: false, error: 'Image too large (max 10MB)' }, 400);
    }

    const ext = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];
    const id = crypto.randomUUID();
    const key = `${id}.${ext}`;

    await c.env.IMAGES.put(key, data, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { originalFilename: filename ?? key },
    });

    const workerUrl = c.env.WORKER_URL || new URL(c.req.url).origin;
    const url = `${workerUrl}/images/${key}`;

    return c.json({
      success: true,
      data: { id, key, url, mimeType, size: data.byteLength },
    }, 201);
  } catch (err) {
    console.error(`POST /api/images error: ${imageRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /images/:key — serve image (public, no auth)
images.get('/images/:key', async (c) => {
  const key = parseImageKey(c.req.param('key'));
  if (!key.ok) return c.json({ success: false, error: 'Image not found' }, 404);
  const object = await c.env.IMAGES.get(key.value);

  if (!object) {
    return c.json({ success: false, error: 'Image not found' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/png');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.etag);

  return new Response(object.body, { headers });
});

// DELETE /api/images/:key — delete image
images.delete('/api/images/:key', requireRole('owner', 'admin'), async (c) => {
  try {
    const key = parseImageKey(c.req.param('key'));
    if (!key.ok) return c.json({ success: false, error: key.error }, 400);
    await c.env.IMAGES.delete(key.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/images/:key error: ${imageRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { images };
