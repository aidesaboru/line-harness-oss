import { Hono } from 'hono';
import { requireRole } from '../middleware/role-guard.js';
import type { Env } from '../index.js';
import { INQUIRY_CATEGORIES, INQUIRY_CLASSIFICATION_VERSION } from '../services/inquiry-analytics.js';

const inquiryAnalytics = new Hono<Env>();
const IMPORT_CONFIRMATION = 'import_inquiry_analytics';

function boundedInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, max)) : fallback;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

inquiryAnalytics.get('/api/inquiry-analytics', requireRole('owner', 'admin', 'staff'), async (c) => {
  const lineAccountId = c.req.query('lineAccountId')?.trim() || null;
  const category = c.req.query('category')?.trim() || null;
  const resolution = c.req.query('resolution')?.trim() || null;
  const query = c.req.query('q')?.trim().slice(0, 80) || null;
  const from = c.req.query('from')?.trim() || null;
  const to = c.req.query('to')?.trim() || null;
  const limit = boundedInteger(c.req.query('limit'), 50, 100);
  const offset = boundedInteger(c.req.query('offset'), 0, 100_000);
  const filters: string[] = [];
  const binds: unknown[] = [];
  if (lineAccountId) { filters.push('line_account_id = ?'); binds.push(lineAccountId); }
  if (category && INQUIRY_CATEGORIES.includes(category as never)) { filters.push('primary_category = ?'); binds.push(category); }
  if (resolution && ['open', 'answered', 'resolved', 'unknown'].includes(resolution)) { filters.push('resolution_status = ?'); binds.push(resolution); }
  if (from && validTimestamp(from)) { filters.push('opened_at >= ?'); binds.push(from); }
  if (to && validTimestamp(to)) { filters.push('opened_at <= ?'); binds.push(to); }
  if (query) { filters.push("(customer_number LIKE ? ESCAPE '\\' OR inquiry_summary LIKE ? ESCAPE '\\' OR COALESCE(resolution_summary, '') LIKE ? ESCAPE '\\')"); const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`; binds.push(like, like, like); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const [totals, categories, trends, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT customer_number) AS customers,
      SUM(CASE WHEN resolution_status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN confidence < 0.6 THEN 1 ELSE 0 END) AS needs_review FROM inquiry_cases ${where}`).bind(...binds).first(),
    c.env.DB.prepare(`SELECT primary_category AS category, COUNT(*) AS count,
      COUNT(DISTINCT customer_number) AS customers FROM inquiry_cases ${where}
      GROUP BY primary_category ORDER BY CASE WHEN primary_category = 'その他' THEN 1 ELSE 0 END, count DESC, category`).bind(...binds).all(),
    c.env.DB.prepare(`SELECT substr(opened_at, 1, 7) AS month, COUNT(*) AS count FROM inquiry_cases ${where}
      GROUP BY substr(opened_at, 1, 7) ORDER BY month`).bind(...binds).all(),
    c.env.DB.prepare(`SELECT id, customer_number, opened_at, last_activity_at, primary_category,
      labels_json, inquiry_summary, resolution_summary, resolution_status, confidence, source_kind
      FROM inquiry_cases ${where} ORDER BY opened_at DESC, id DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all(),
  ]);

  return c.json({ success: true, data: {
    totals: totals ?? { total: 0, customers: 0, resolved: 0, needs_review: 0 },
    categories: categories.results ?? [], trends: trends.results ?? [],
    cases: (rows.results ?? []).map((row: Record<string, unknown>) => ({ ...row, labels: JSON.parse(String(row.labels_json ?? '[]')), labels_json: undefined })),
    limit, offset,
  } });
});

inquiryAnalytics.post('/api/inquiry-analytics/import', requireRole('owner', 'admin'), async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ success: false, error: 'invalid_json' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ success: false, error: 'invalid_body' }, 400);
  const input = body as Record<string, unknown>;
  if (input.confirm !== IMPORT_CONFIRMATION) return c.json({ success: false, error: 'confirmation_required' }, 409);
  if (!Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 100) return c.json({ success: false, error: 'invalid_cases' }, 400);
  const statements: D1PreparedStatement[] = [];
  const now = new Date().toISOString();
  for (const raw of input.cases) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ success: false, error: 'invalid_case' }, 400);
    const item = raw as Record<string, unknown>;
    if (!validTimestamp(item.openedAt) || !validTimestamp(item.lastActivityAt)) return c.json({ success: false, error: 'invalid_timestamp' }, 400);
    if (typeof item.sourceRef !== 'string' || item.sourceRef.length > 128 || !item.sourceRef) return c.json({ success: false, error: 'invalid_source_ref' }, 400);
    if (typeof item.inquirySummary !== 'string' || item.inquirySummary.length > 500 || !item.inquirySummary.trim()) return c.json({ success: false, error: 'invalid_summary' }, 400);
    const primary = typeof item.primaryCategory === 'string' && INQUIRY_CATEGORIES.includes(item.primaryCategory as never) ? item.primaryCategory : 'その他';
    const status = typeof item.resolutionStatus === 'string' && ['open', 'answered', 'resolved', 'unknown'].includes(item.resolutionStatus) ? item.resolutionStatus : 'unknown';
    const labels = Array.isArray(item.labels) ? item.labels.filter((label): label is string => typeof label === 'string' && INQUIRY_CATEGORIES.includes(label as never)).slice(0, 12) : [];
    const resolutionSummary = typeof item.resolutionSummary === 'string' ? item.resolutionSummary.slice(0, 500) : null;
    const customerNumber = typeof item.customerNumber === 'string' ? item.customerNumber.slice(0, 32) : null;
    const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : 0;
    statements.push(c.env.DB.prepare(
      `INSERT INTO inquiry_cases (id, line_account_id, subject_kind, subject_id, customer_number, opened_at,
       last_activity_at, primary_category, labels_json, inquiry_summary, resolution_summary, resolution_status,
       confidence, source_kind, source_ref, classification_version, created_at, updated_at)
       VALUES (?, ?, 'historical', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'csv', ?, ?, ?, ?)
       ON CONFLICT(source_ref) DO UPDATE SET customer_number = excluded.customer_number,
       opened_at = excluded.opened_at, last_activity_at = excluded.last_activity_at,
       primary_category = excluded.primary_category, labels_json = excluded.labels_json,
       inquiry_summary = excluded.inquiry_summary, resolution_summary = excluded.resolution_summary,
       resolution_status = excluded.resolution_status, confidence = excluded.confidence,
       classification_version = excluded.classification_version, updated_at = excluded.updated_at`,
    ).bind(crypto.randomUUID(), typeof input.lineAccountId === 'string' ? input.lineAccountId : null,
      customerNumber, item.openedAt, item.lastActivityAt, primary, JSON.stringify(labels), item.inquirySummary.trim(),
      resolutionSummary, status, confidence, item.sourceRef, INQUIRY_CLASSIFICATION_VERSION, now, now));
  }
  await c.env.DB.batch(statements);
  return c.json({ success: true, data: { imported: statements.length } });
});

export { inquiryAnalytics };
