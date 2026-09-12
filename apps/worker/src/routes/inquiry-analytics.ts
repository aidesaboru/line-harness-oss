import { Hono } from 'hono';
import { requireRole } from '../middleware/role-guard.js';
import type { Env } from '../index.js';
import {
  INQUIRY_CATEGORIES,
  INQUIRY_CLASSIFICATION_VERSION,
  inquiryGenreSql,
  isInquiryGenreForCategory,
  type InquiryCategory,
} from '../services/inquiry-analytics.js';

const inquiryAnalytics = new Hono<Env>();
const IMPORT_CONFIRMATION = 'import_inquiry_analytics';

function boundedInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, max)) : fallback;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

export type InquiryTrendGranularity = 'day' | 'week' | 'month';

export function inquiryTrendPeriodSql(granularity: InquiryTrendGranularity, column = 'opened_at'): string {
  if (granularity === 'day') return `substr(${column}, 1, 10)`;
  if (granularity === 'week') {
    return `date(${column}, '-' || ((CAST(strftime('%w', ${column}) AS INTEGER) + 6) % 7) || ' days')`;
  }
  return `substr(${column}, 1, 7)`;
}

export function fillInquiryTrendPeriods(
  rows: ReadonlyArray<{ period: string; count: number }>,
  granularity: InquiryTrendGranularity,
  limit: number,
): Array<{ period: string; count: number }> {
  const normalized = rows
    .map((row) => ({ period: String(row.period), count: Number(row.count) || 0 }))
    .filter((row) => row.period)
    .sort((a, b) => a.period.localeCompare(b.period));
  const lastPeriod = normalized.at(-1)?.period;
  if (!lastPeriod || limit < 1) return normalized;
  const counts = new Map(normalized.map((row) => [row.period, row.count]));
  const periods: string[] = [];

  if (granularity === 'month') {
    const [year, month] = lastPeriod.split('-').map(Number);
    if (!Number.isFinite(year) || !Number.isFinite(month)) return normalized;
    for (let index = limit - 1; index >= 0; index -= 1) {
      const date = new Date(Date.UTC(year, month - 1 - index, 1));
      periods.push(date.toISOString().slice(0, 7));
    }
  } else {
    const end = new Date(`${lastPeriod}T00:00:00.000Z`);
    if (Number.isNaN(end.getTime())) return normalized;
    const stepDays = granularity === 'week' ? 7 : 1;
    for (let index = limit - 1; index >= 0; index -= 1) {
      const date = new Date(end);
      date.setUTCDate(date.getUTCDate() - index * stepDays);
      periods.push(date.toISOString().slice(0, 10));
    }
  }

  return periods.map((period) => ({ period, count: counts.get(period) ?? 0 }));
}

function whereClause(filters: readonly string[]): string {
  return filters.length ? `WHERE ${filters.join(' AND ')}` : '';
}

inquiryAnalytics.get('/api/inquiry-analytics', requireRole('owner', 'admin', 'staff'), async (c) => {
  const lineAccountId = c.req.query('lineAccountId')?.trim() || null;
  const category = c.req.query('category')?.trim() || null;
  const genre = c.req.query('genre')?.trim() || null;
  const granularityInput = c.req.query('granularity')?.trim() || 'month';
  const resolution = c.req.query('resolution')?.trim() || null;
  const query = c.req.query('q')?.trim().slice(0, 80) || null;
  const from = c.req.query('from')?.trim() || null;
  const to = c.req.query('to')?.trim() || null;
  const limit = boundedInteger(c.req.query('limit'), 50, 100);
  const offset = boundedInteger(c.req.query('offset'), 0, 100_000);
  if (category && !INQUIRY_CATEGORIES.includes(category as InquiryCategory)) {
    return c.json({ success: false, error: 'invalid_category' }, 400);
  }
  if (genre && (!category || !isInquiryGenreForCategory(category as InquiryCategory, genre))) {
    return c.json({ success: false, error: 'invalid_genre' }, 400);
  }
  if (!['day', 'week', 'month'].includes(granularityInput)) {
    return c.json({ success: false, error: 'invalid_granularity' }, 400);
  }
  if (resolution && !['open', 'answered', 'resolved', 'unknown'].includes(resolution)) {
    return c.json({ success: false, error: 'invalid_resolution' }, 400);
  }

  const granularity = granularityInput as InquiryTrendGranularity;
  const baseFilters: string[] = [];
  const baseBinds: unknown[] = [];
  if (lineAccountId) { baseFilters.push('line_account_id = ?'); baseBinds.push(lineAccountId); }
  if (from && validTimestamp(from)) { baseFilters.push('opened_at >= ?'); baseBinds.push(from); }
  if (to && validTimestamp(to)) { baseFilters.push('opened_at <= ?'); baseBinds.push(to); }

  const genreExpression = inquiryGenreSql();
  const scopeFilters = [...baseFilters];
  const scopeBinds = [...baseBinds];
  if (category) { scopeFilters.push('primary_category = ?'); scopeBinds.push(category); }
  if (genre) { scopeFilters.push(`${genreExpression} = ?`); scopeBinds.push(genre); }

  const caseFilters = [...scopeFilters];
  const caseBinds = [...scopeBinds];
  if (resolution) { caseFilters.push('resolution_status = ?'); caseBinds.push(resolution); }
  if (query) {
    caseFilters.push("(customer_number LIKE ? ESCAPE '\\' OR inquiry_summary LIKE ? ESCAPE '\\' OR COALESCE(resolution_summary, '') LIKE ? ESCAPE '\\')");
    const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    caseBinds.push(like, like, like);
  }

  const baseWhere = whereClause(baseFilters);
  const scopeWhere = whereClause(scopeFilters);
  const caseWhere = whereClause(caseFilters);
  const categoryWhere = whereClause([...baseFilters, 'primary_category = ?']);
  const periodExpression = inquiryTrendPeriodSql(granularity);
  const trendLimit = granularity === 'day' ? 31 : granularity === 'week' ? 26 : 36;

  const [totals, categories, genres, trends, filteredTotal, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT customer_number) AS customers,
      COALESCE(SUM(CASE WHEN resolution_status = 'resolved' THEN 1 ELSE 0 END), 0) AS resolved,
      COALESCE(SUM(CASE WHEN confidence < 0.6 THEN 1 ELSE 0 END), 0) AS needs_review
      FROM inquiry_cases ${baseWhere}`).bind(...baseBinds).first(),
    c.env.DB.prepare(`SELECT primary_category AS category, COUNT(*) AS count,
      COUNT(DISTINCT customer_number) AS customers FROM inquiry_cases ${baseWhere}
      GROUP BY primary_category ORDER BY CASE WHEN primary_category = 'その他' THEN 1 ELSE 0 END, count DESC, category`).bind(...baseBinds).all(),
    category
      ? c.env.DB.prepare(`SELECT genre, COUNT(*) AS count, COUNT(DISTINCT customer_number) AS customers
          FROM (SELECT customer_number, ${genreExpression} AS genre FROM inquiry_cases ${categoryWhere})
          GROUP BY genre ORDER BY count DESC, genre`).bind(...baseBinds, category).all()
      : Promise.resolve({ results: [] }),
    c.env.DB.prepare(`SELECT period, count FROM (
      SELECT ${periodExpression} AS period, COUNT(*) AS count FROM inquiry_cases ${scopeWhere}
      GROUP BY ${periodExpression} ORDER BY period DESC LIMIT ?
    ) ORDER BY period`).bind(...scopeBinds, trendLimit).all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM inquiry_cases ${caseWhere}`).bind(...caseBinds).first<{ total: number }>(),
    c.env.DB.prepare(`SELECT id, customer_number, opened_at, last_activity_at, primary_category,
      ${genreExpression} AS genre, labels_json, inquiry_summary, resolution_summary, resolution_status,
      confidence, source_kind FROM inquiry_cases ${caseWhere}
      ORDER BY opened_at DESC, id DESC LIMIT ? OFFSET ?`).bind(...caseBinds, limit, offset).all(),
  ]);

  return c.json({ success: true, data: {
    totals: totals ?? { total: 0, customers: 0, resolved: 0, needs_review: 0 },
    categories: categories.results ?? [],
    genres: genres.results ?? [],
    trends: fillInquiryTrendPeriods(
      (trends.results ?? []) as Array<{ period: string; count: number }>,
      granularity,
      trendLimit,
    ),
    cases: (rows.results ?? []).map((row: Record<string, unknown>) => ({ ...row, labels: JSON.parse(String(row.labels_json ?? '[]')), labels_json: undefined })),
    filtered_total: Number(filteredTotal?.total ?? 0), trend_granularity: granularity, limit, offset,
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
