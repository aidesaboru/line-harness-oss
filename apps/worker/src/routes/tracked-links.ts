import { Hono } from 'hono';
import {
  getTrackedLinks,
  getTrackedLinkById,
  createTrackedLink,
  updateTrackedLink,
  deleteTrackedLink,
  recordLinkClick,
  getLinkClicks,
} from '@line-crm/db';
import type { TrackedLink } from '@line-crm/db';
import type { Env } from '../index.js';
import { requireRole } from '../middleware/role-guard.js';

const trackedLinks = new Hono<Env>();
const LIFF_TRACKED_LINK_RETURN_PARAM = 'lh_liff';
const TRACKED_LINK_ID_MAX_LENGTH = 128;
const TRACKED_LINK_ID_PATTERN = /^[!-~]+$/;
const TRACKED_LINK_NAME_MAX_LENGTH = 160;
const TRACKED_LINK_ORIGINAL_URL_MAX_LENGTH = 2048;

type ParsedCreateTrackedLinkBody =
  | {
      ok: true;
      body: {
        name: string;
        originalUrl: string;
        tagId: string | null;
        scenarioId: string | null;
        introTemplateId: string | null;
        rewardTemplateId: string | null;
      };
    }
  | { ok: false; error: string };
type ParsedUpdateTrackedLinkBody =
  | {
      ok: true;
      body: {
        name?: string;
        tagId?: string | null;
        scenarioId?: string | null;
        introTemplateId?: string | null;
        rewardTemplateId?: string | null;
        isActive?: boolean;
      };
    }
  | { ok: false; error: string };

function serializeTrackedLink(row: TrackedLink, baseUrl: string) {
  const trackingUrl = `${baseUrl}/t/${row.id}`;
  return {
    id: row.id,
    name: row.name,
    originalUrl: row.original_url,
    trackingUrl,
    tagId: row.tag_id,
    scenarioId: row.scenario_id,
    introTemplateId: row.intro_template_id,
    rewardTemplateId: row.reward_template_id,
    isActive: Boolean(row.is_active),
    clickCount: row.click_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getBaseUrl(c: { req: { url: string } }): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown | null> {
  return c.req.json().catch(() => null);
}

function parsePublicTrackedLinkId(raw: string | undefined): string | null {
  const linkId = raw?.trim() ?? '';
  if (!linkId) return null;
  if (linkId.length > TRACKED_LINK_ID_MAX_LENGTH) return null;
  if (!TRACKED_LINK_ID_PATTERN.test(linkId)) return null;
  return linkId;
}

function parseTrackedLinkPathId(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'trackedLinkId must be a string' };
  const value = raw.trim();
  if (!value) return { ok: false, error: 'trackedLinkId is required' };
  if (value.length > TRACKED_LINK_ID_MAX_LENGTH || !TRACKED_LINK_ID_PATTERN.test(value)) {
    return { ok: false, error: 'trackedLinkId is invalid' };
  }
  return { ok: true, value };
}

function parseTrackedLinkName(raw: unknown, required: boolean): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw == null) return required ? { ok: false, error: 'name is required' } : { ok: true };
  if (typeof raw !== 'string') return { ok: false, error: 'name must be a string' };
  const value = raw.trim();
  if (!value) return { ok: false, error: 'name is required' };
  if (value.length > TRACKED_LINK_NAME_MAX_LENGTH) return { ok: false, error: 'name is too long' };
  return { ok: true, value };
}

function parseTrackedLinkOriginalUrl(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'originalUrl is required' };
  const value = raw.trim();
  if (!value) return { ok: false, error: 'originalUrl is required' };
  if (value.length > TRACKED_LINK_ORIGINAL_URL_MAX_LENGTH) return { ok: false, error: 'originalUrl is too long' };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'originalUrl must be http(s)' };
    }
  } catch {
    return { ok: false, error: 'originalUrl must be valid' };
  }
  return { ok: true, value };
}

function parseOptionalTrackedLinkRef(raw: unknown, key: string): { ok: true; value?: string | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${key} must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > TRACKED_LINK_ID_MAX_LENGTH || !TRACKED_LINK_ID_PATTERN.test(value)) {
    return { ok: false, error: `${key} is invalid` };
  }
  return { ok: true, value };
}

function parseCreateTrackedLinkBody(raw: unknown): ParsedCreateTrackedLinkBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };

  const name = parseTrackedLinkName(raw.name, true);
  if (!name.ok) return name;
  const originalUrl = parseTrackedLinkOriginalUrl(raw.originalUrl);
  if (!originalUrl.ok) return originalUrl;

  const tagId = parseOptionalTrackedLinkRef(raw.tagId, 'tagId');
  if (!tagId.ok) return tagId;
  const scenarioId = parseOptionalTrackedLinkRef(raw.scenarioId, 'scenarioId');
  if (!scenarioId.ok) return scenarioId;
  const introTemplateId = parseOptionalTrackedLinkRef(raw.introTemplateId, 'introTemplateId');
  if (!introTemplateId.ok) return introTemplateId;
  const rewardTemplateId = parseOptionalTrackedLinkRef(raw.rewardTemplateId, 'rewardTemplateId');
  if (!rewardTemplateId.ok) return rewardTemplateId;

  return {
    ok: true,
    body: {
      name: name.value!,
      originalUrl: originalUrl.value,
      tagId: tagId.value ?? null,
      scenarioId: scenarioId.value ?? null,
      introTemplateId: introTemplateId.value ?? null,
      rewardTemplateId: rewardTemplateId.value ?? null,
    },
  };
}

function parseUpdateTrackedLinkBody(raw: unknown): ParsedUpdateTrackedLinkBody {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid payload' };

  const name = parseTrackedLinkName(raw.name, false);
  if (!name.ok) return name;
  const tagId = parseOptionalTrackedLinkRef(raw.tagId, 'tagId');
  if (!tagId.ok) return tagId;
  const scenarioId = parseOptionalTrackedLinkRef(raw.scenarioId, 'scenarioId');
  if (!scenarioId.ok) return scenarioId;
  const introTemplateId = parseOptionalTrackedLinkRef(raw.introTemplateId, 'introTemplateId');
  if (!introTemplateId.ok) return introTemplateId;
  const rewardTemplateId = parseOptionalTrackedLinkRef(raw.rewardTemplateId, 'rewardTemplateId');
  if (!rewardTemplateId.ok) return rewardTemplateId;
  if (raw.isActive !== undefined && typeof raw.isActive !== 'boolean') {
    return { ok: false, error: 'isActive must be boolean' };
  }

  return {
    ok: true,
    body: {
      name: name.value,
      tagId: tagId.value,
      scenarioId: scenarioId.value,
      introTemplateId: introTemplateId.value,
      rewardTemplateId: rewardTemplateId.value,
      isActive: raw.isActive,
    },
  };
}

function trackedLinkRouteErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

// GET /api/tracked-links — list all
trackedLinks.get('/api/tracked-links', requireRole('owner', 'admin'), async (c) => {
  try {
    const items = await getTrackedLinks(c.env.DB);
    const base = getBaseUrl(c);
    return c.json({ success: true, data: items.map((item) => serializeTrackedLink(item, base)) });
  } catch (err) {
    console.error(`GET /api/tracked-links error: ${trackedLinkRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/tracked-links/:id — get single with click details
trackedLinks.get('/api/tracked-links/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseTrackedLinkPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const link = await getTrackedLinkById(c.env.DB, id.value);
    if (!link) {
      return c.json({ success: false, error: 'Tracked link not found' }, 404);
    }
    const clicks = await getLinkClicks(c.env.DB, id.value);
    const base = getBaseUrl(c);
    return c.json({
      success: true,
      data: {
        ...serializeTrackedLink(link, base),
        clicks: clicks.map((click) => ({
          id: click.id,
          friendId: click.friend_id,
          friendDisplayName: click.friend_display_name,
          clickedAt: click.clicked_at,
        })),
      },
    });
  } catch (err) {
    console.error(`GET /api/tracked-links/:id error: ${trackedLinkRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/tracked-links — create
trackedLinks.post('/api/tracked-links', requireRole('owner', 'admin'), async (c) => {
  try {
    const rawBody = await readJsonBody(c);
    const parsed = parseCreateTrackedLinkBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const body = parsed.body;

    const link = await createTrackedLink(c.env.DB, {
      name: body.name,
      originalUrl: body.originalUrl,
      tagId: body.tagId ?? null,
      scenarioId: body.scenarioId ?? null,
      introTemplateId: body.introTemplateId ?? null,
      rewardTemplateId: body.rewardTemplateId ?? null,
    });

    const base = getBaseUrl(c);
    return c.json({ success: true, data: serializeTrackedLink(link, base) }, 201);
  } catch (err) {
    console.error(`POST /api/tracked-links error: ${trackedLinkRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PATCH /api/tracked-links/:id — update mutable fields
trackedLinks.patch('/api/tracked-links/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseTrackedLinkPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const rawBody = await readJsonBody(c);
    const parsed = parseUpdateTrackedLinkBody(rawBody);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);

    const link = await updateTrackedLink(c.env.DB, id.value, parsed.body);
    if (!link) {
      return c.json({ success: false, error: 'Tracked link not found' }, 404);
    }
    const base = getBaseUrl(c);
    return c.json({ success: true, data: serializeTrackedLink(link, base) });
  } catch (err) {
    console.error(`PATCH /api/tracked-links/:id error: ${trackedLinkRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/tracked-links/:id
trackedLinks.delete('/api/tracked-links/:id', requireRole('owner', 'admin'), async (c) => {
  try {
    const id = parseTrackedLinkPathId(c.req.param('id'));
    if (!id.ok) return c.json({ success: false, error: id.error }, 400);
    const link = await getTrackedLinkById(c.env.DB, id.value);
    if (!link) {
      return c.json({ success: false, error: 'Tracked link not found' }, 404);
    }
    await deleteTrackedLink(c.env.DB, id.value);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error(`DELETE /api/tracked-links/:id error: ${trackedLinkRouteErrorKind(err)}`);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// Domains where Universal Links should be used (JS redirect instead of 302)
const APP_LINK_DOMAINS = new Set([
  'x.com',
  'twitter.com',
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'facebook.com',
  'github.com',
]);

function isAppLinkDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return APP_LINK_DOMAINS.has(hostname);
  } catch {
    return false;
  }
}

// Android app package names for intent:// deep links
const ANDROID_PACKAGES: Record<string, string> = {
  'x.com': 'com.twitter.android',
  'twitter.com': 'com.twitter.android',
  'instagram.com': 'com.instagram.android',
  'youtube.com': 'com.google.android.youtube',
  'youtu.be': 'com.google.android.youtube',
  'tiktok.com': 'com.zhiliaoapp.musically',
  'facebook.com': 'com.facebook.katana',
  'github.com': 'com.github.android',
};

function getAndroidPackage(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return ANDROID_PACKAGES[hostname] ?? null;
  } catch {
    return null;
  }
}

function buildAppRedirectHtml(destinationUrl: string): string {
  const escaped = destinationUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const androidPackage = getAndroidPackage(destinationUrl);
  // intent://path#Intent;scheme=https;package=com.xxx;S.browser_fallback_url=https://...;end
  const intentUrl = androidPackage
    ? `intent://${destinationUrl.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=${androidPackage};S.browser_fallback_url=${encodeURIComponent(destinationUrl)};end`
    : null;
  const intentEscaped = intentUrl ? intentUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;') : '';

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Redirecting...</title>
<style>body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui;color:#64748b;background:#f8fafc}p{font-size:14px}</style>
</head><body>
<p>Opening app...</p>
<script>
(function(){
  var isAndroid = /Android/i.test(navigator.userAgent);
  if(isAndroid && "${intentEscaped}"){
    window.location.href="${intentEscaped}";
  } else {
    window.location.href="${escaped}";
  }
})();
</script>
<noscript><meta http-equiv="refresh" content="0;url=${escaped}"></noscript>
</body></html>`;
}

// GET /t/:linkId — click tracking redirect (no auth, fast redirect)
trackedLinks.get('/t/:linkId', async (c) => {
  const linkId = parsePublicTrackedLinkId(c.req.param('linkId'));
  if (!linkId) {
    return c.json({ success: false, error: 'Link not found' }, 404);
  }
  const returnedFromVerifiedLiff = c.req.query(LIFF_TRACKED_LINK_RETURN_PARAM) === '1';

  // Look up the link first
  const link = await getTrackedLinkById(c.env.DB, linkId);

  if (!link || !link.is_active) {
    return c.json({ success: false, error: 'Link not found' }, 404);
  }

  const useAppRedirect = isAppLinkDomain(link.original_url);

  // If no user ID yet, check if this is LINE's in-app browser → redirect to LIFF for identification
  // Skip LIFF redirect for app-link domains (they'll come from Safari via externalBrowser)
  const ua = c.req.header('user-agent') || '';
  const isLineApp = /\bLine\b/i.test(ua);
  if (!useAppRedirect && !returnedFromVerifiedLiff && isLineApp && c.env.LIFF_URL) {
    const directUrl = new URL(
      `/t/${encodeURIComponent(linkId)}`,
      c.env.WORKER_URL || new URL(c.req.url).origin,
    );
    directUrl.searchParams.set(LIFF_TRACKED_LINK_RETURN_PARAM, '1');
    const liffRedirect = new URL(c.env.LIFF_URL);
    liffRedirect.searchParams.set('redirect', directUrl.toString());
    liffRedirect.searchParams.set('ref', linkId);
    return c.redirect(liffRedirect, 302);
  }

  // Run side-effects async. Friend-specific attribution is handled by
  // /api/liff/link after LINE ID token verification; public query params on
  // this redirect endpoint must never self-attest a friend.
  const ctx = c.executionCtx as ExecutionContext;
  ctx.waitUntil(
    (async () => {
      try {
        if (!returnedFromVerifiedLiff) {
          await recordLinkClick(c.env.DB, linkId, null);
        }
      } catch (err) {
        console.error(`/t/:linkId async tracking error: ${trackedLinkRouteErrorKind(err)}`);
      }
    })(),
  );

  // App-link domains: return HTML with JS redirect for Universal Link support
  if (useAppRedirect) {
    return c.html(buildAppRedirectHtml(link.original_url));
  }

  return c.redirect(link.original_url, 302);
});

export { trackedLinks };
