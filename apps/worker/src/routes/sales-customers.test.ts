import { describe, expect, test, vi } from 'vitest'
import { Hono } from 'hono'
import { salesCustomers } from './sales-customers.js'

type StaffRole = 'owner' | 'admin' | 'staff' | 'secondary'
type TestStaff = {
  id: string
  name: string
  role: StaffRole
  secondaryCanRespond: boolean
  salesOnly: boolean
}
type TestEnv = {
  Variables: { staff: TestStaff }
  Bindings: { DB: D1Database; AI?: Ai }
}

type SubjectRow = {
  subject_kind: 'friend' | 'conversation'
  subject_id: string
  source_kind: 'user' | 'group' | 'room'
  line_account_id: string
  line_account_name: string
  display_name: string
  customer_metadata: string
  subject_created_at: string
  status_id: string | null
  sales_status: 'unreviewed' | 'normal' | 'attention' | 'complaint' | 'exit_pending' | 'exited'
  status_source: 'manual' | 'ai' | null
  status_source_fingerprint: string | null
  status_version: number | null
  status_updated_by_name: string | null
  status_updated_at: string | null
  timeline_id: string | null
  timeline_current_state: string | null
  timeline_recognized_status: SubjectRow['sales_status'] | null
  timeline_resolution_confirmed: number | null
  timeline_json: string | null
  timeline_generation_method: string | null
  timeline_ai_generated: number | null
  timeline_model: string | null
  timeline_prompt_version: string | null
  timeline_source_fingerprint: string | null
  timeline_source_message_count: number | null
  timeline_source_from_at: string | null
  timeline_source_to_at: string | null
  timeline_input_char_count: number | null
  timeline_version: number | null
  timeline_updated_by_name: string | null
  timeline_updated_at: string | null
  is_following: number | null
  chat_status: 'unread' | 'in_progress' | 'resolved' | 'long_term' | null
  activity_last_at?: string | null
  activity_last_incoming_at?: string | null
  activity_last_human_outgoing_at?: string | null
  activity_needs_human_reply?: number
  activity_30_total?: number
  activity_30_incoming?: number
  activity_30_human_outgoing?: number
  activity_30_automated_outgoing?: number
  activity_30_active_days?: number
  activity_30_media?: number
  activity_60_total?: number
  activity_60_incoming?: number
  activity_60_human_outgoing?: number
  activity_60_automated_outgoing?: number
  activity_60_active_days?: number
  activity_60_media?: number
  activity_90_total?: number
  activity_90_incoming?: number
  activity_90_human_outgoing?: number
  activity_90_automated_outgoing?: number
  activity_90_active_days?: number
  activity_90_media?: number
  active_support_cases?: number
  support_cases_90?: number
  last_support_updated_at?: string | null
}

const directRow: SubjectRow = {
  subject_kind: 'friend',
  subject_id: 'friend-1',
  source_kind: 'user',
  line_account_id: 'account-1',
  line_account_name: 'メインLINE',
  display_name: 'LINE田中',
  customer_metadata: JSON.stringify({
    customerNumber: 'C-001',
    companyName: '田中商事',
    contactName: '田中様',
    operationContracts: [{ shopName: '楽天店' }],
    privateConversation: '出力してはいけない会話',
  }),
  subject_created_at: '2026-09-01T10:00:00+09:00',
  status_id: 'status-1',
  sales_status: 'complaint',
  status_source: 'ai',
  status_source_fingerprint: 'b'.repeat(64),
  status_version: 2,
  status_updated_by_name: '運営担当',
  status_updated_at: '2026-09-09T10:00:00+09:00',
  timeline_id: 'timeline-1',
  timeline_current_state: '返品に関する苦情を受け、返送方法を確認中である。',
  timeline_recognized_status: 'complaint',
  timeline_resolution_confirmed: 0,
  timeline_json: JSON.stringify([{
    occurredAt: '2026-09-09T08:00:00+09:00',
    kind: 'customer_contact',
    title: '返品の苦情を受信',
    detail: '顧客から返品方法への苦情が届いた。',
    state: 'open',
  }]),
  timeline_generation_method: 'situation_timeline_v1',
  timeline_ai_generated: 1,
  timeline_model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  timeline_prompt_version: 'sales_situation_timeline_v1',
  timeline_source_fingerprint: 'a'.repeat(64),
  timeline_source_message_count: 2,
  timeline_source_from_at: '2026-09-09T08:00:00+09:00',
  timeline_source_to_at: '2026-09-09T09:00:00+09:00',
  timeline_input_char_count: 100,
  timeline_version: 1,
  timeline_updated_by_name: '運営担当',
  timeline_updated_at: '2026-09-10T10:00:00+09:00',
  is_following: 1,
  chat_status: 'in_progress',
  activity_last_at: '2026-09-09T09:00:00+09:00',
  activity_last_incoming_at: '2026-09-09T09:00:00+09:00',
  activity_last_human_outgoing_at: '2026-09-08T18:00:00+09:00',
  activity_needs_human_reply: 1,
  activity_30_total: 12,
  activity_30_incoming: 5,
  activity_30_human_outgoing: 4,
  activity_30_automated_outgoing: 3,
  activity_30_active_days: 4,
  activity_30_media: 2,
  activity_60_total: 18,
  activity_60_incoming: 8,
  activity_60_human_outgoing: 6,
  activity_60_automated_outgoing: 4,
  activity_60_active_days: 7,
  activity_60_media: 3,
  activity_90_total: 24,
  activity_90_incoming: 10,
  activity_90_human_outgoing: 8,
  activity_90_automated_outgoing: 6,
  activity_90_active_days: 9,
  activity_90_media: 4,
  active_support_cases: 1,
  support_cases_90: 2,
  last_support_updated_at: '2026-09-08T12:00:00+09:00',
}

const groupRow: SubjectRow = {
  ...directRow,
  subject_kind: 'conversation',
  subject_id: 'conversation-1',
  source_kind: 'group',
  display_name: '山田店チーム',
  customer_metadata: JSON.stringify({ customerNumber: 'C-002', companyName: '株式会社STAR FIELD' }),
  status_id: null,
  sales_status: 'unreviewed',
  status_source: null,
  status_source_fingerprint: null,
  status_version: null,
  status_updated_by_name: null,
  status_updated_at: null,
  timeline_id: null,
  timeline_current_state: null,
  timeline_recognized_status: null,
  timeline_resolution_confirmed: null,
  timeline_json: null,
  timeline_generation_method: null,
  timeline_ai_generated: null,
  timeline_model: null,
  timeline_prompt_version: null,
  timeline_source_fingerprint: null,
  timeline_source_message_count: null,
  timeline_source_from_at: null,
  timeline_source_to_at: null,
  timeline_input_char_count: null,
  timeline_version: null,
  timeline_updated_by_name: null,
  timeline_updated_at: null,
  is_following: null,
  chat_status: 'resolved',
}

function setupApp(db: D1Database, staff: Partial<TestStaff> = {}, ai?: Ai) {
  const app = new Hono<TestEnv>()
  app.use('*', async (c, next) => {
    c.set('staff', {
      id: 'staff-1',
      name: '運営担当',
      role: 'staff',
      secondaryCanRespond: false,
      salesOnly: false,
      ...staff,
    })
    c.env = { DB: db, AI: ai }
    await next()
  })
  app.route('/', salesCustomers)
  return app
}

function readDb() {
  const calls: Array<{ sql: string; binds: unknown[]; method: 'all' | 'first' }> = []
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = []
      const statement = {
        bind(...values: unknown[]) {
          binds = values
          return statement
        },
        async all<T>() {
          calls.push({ sql, binds, method: 'all' })
          if (sql.includes('FROM line_accounts')) {
            return {
              results: [{
                id: 'account-1',
                name: 'メインLINE',
                is_active: 1,
                country: 'JP',
                role: 'support',
                display_order: 0,
              }],
            } as { results: T[] }
          }
          if (sql.includes('GROUP BY sales_status')) {
            return {
              results: [
                { status: 'complaint', count: 1 },
                { status: 'unreviewed', count: 1 },
              ],
            } as { results: T[] }
          }
          if (sql.includes('FROM sales_customer_status_events')) {
            return {
              results: [{
                id: 'event-1',
                from_status: 'attention',
                to_status: 'complaint',
                summary: '会話タイムラインの自動判定',
                source: 'ai',
                actor_name: '運営担当',
                created_at: directRow.status_updated_at,
              }],
            } as { results: T[] }
          }
          if (sql.includes('FROM customer_subjects cs')) {
            return { results: [directRow, groupRow] } as { results: T[] }
          }
          return { results: [] } as { results: T[] }
        },
        async first<T>() {
          calls.push({ sql, binds, method: 'first' })
          if (sql.includes('COUNT(*) AS count')) return { count: 2 } as T
          if (sql.includes('FROM customer_subjects cs')) {
            return (binds[binds.length - 2] === 'conversation' ? groupRow : directRow) as T
          }
          return null
        },
      }
      return statement
    },
  } as unknown as D1Database
  return { db, calls }
}

describe('sales customer read APIs', () => {
  test('returns only minimal active account fields', async () => {
    const { db } = readDb()
    const response = await setupApp(db, { salesOnly: true }).request('/api/sales-customers/accounts')

    expect(response.status).toBe(200)
    const body = await response.json() as { data: Array<Record<string, unknown>> }
    expect(body.data).toEqual([{
      id: 'account-1',
      name: 'メインLINE',
      displayName: 'メインLINE',
      isActive: true,
      country: 'JP',
      role: 'support',
      displayOrder: 0,
    }])
    expect(body.data[0]).not.toHaveProperty('channelId')
    expect(body.data[0]).not.toHaveProperty('channelAccessToken')
  })

  test('combines direct and group customers without exposing metadata or messages', async () => {
    const { db, calls } = readDb()
    const response = await setupApp(db, { salesOnly: true }).request(
      '/api/sales-customers?lineAccountId=account-1&status=action_required',
    )

    expect(response.status).toBe(200)
    const body = await response.json() as {
      data: { items: Array<Record<string, unknown>>; counts: Record<string, number>; canRunBatch: boolean }
    }
    expect(body.data.items).toHaveLength(2)
    expect(body.data.items[0]).toMatchObject({
      subjectKind: 'friend',
      subjectId: 'friend-1',
      companyName: '田中商事',
      contactName: '田中様',
      customerNumber: 'C-001',
      storeNames: ['楽天店'],
      status: 'complaint',
      statusSource: 'ai',
      situation: {
        currentState: directRow.timeline_current_state,
        recognizedStatus: 'complaint',
        resolutionConfirmed: false,
        stored: true,
        version: 1,
        method: 'situation_timeline_v1',
        aiGenerated: true,
        sourceMessageCount: 2,
        events: [expect.objectContaining({ title: '返品の苦情を受信' })],
      },
    })
    expect(body.data.items[1]).toMatchObject({
      subjectKind: 'conversation',
      sourceKind: 'group',
      companyName: '株式会社STAR FIELD',
      status: 'unreviewed',
      version: 0,
      situation: {
        stored: false,
        version: 0,
        events: [],
      },
    })
    expect(body.data.canRunBatch).toBe(false)
    expect(body.data.counts).toMatchObject({ complaint: 1, unreviewed: 1, normal: 0 })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('privateConversation')
    expect(serialized).not.toContain('出力してはいけない会話')
    expect(serialized).not.toContain('customer_metadata')
    expect(serialized).not.toContain('sender_user_id')
    expect(calls.some((call) => call.sql.includes("source_type IN ('group', 'room')"))).toBe(true)
    expect(calls.some((call) => call.sql.includes('sales_customer_situation_timelines'))).toBe(true)
    expect(calls.every((call) => !call.sql.includes('sales_customer_semantic_summaries_v3'))).toBe(true)
    expect(calls.every((call) => !call.sql.includes('customer_message_activity'))).toBe(true)
    expect(calls.every((call) => !call.sql.includes('support_cases'))).toBe(true)
  })

  test('searches only sales-visible identity fields instead of raw metadata', async () => {
    const { db, calls } = readDb()
    const response = await setupApp(db, { salesOnly: true }).request(
      '/api/sales-customers?lineAccountId=account-1&q=%E7%94%B0%E4%B8%AD',
    )

    expect(response.status).toBe(200)
    const listCall = calls.find((call) => call.method === 'all' && call.sql.includes('ORDER BY CASE sales_status'))
    expect(listCall?.sql).toContain("json_extract(customer_metadata, '$.companyName')")
    expect(listCall?.sql).toContain("json_extract(customer_metadata, '$.contactName')")
    expect(listCall?.sql).not.toContain("lower(COALESCE(customer_metadata, '{}'))")
    expect(listCall?.sql).not.toContain('privateConversation')
    expect(listCall?.binds.filter((value) => value === '田中')).toHaveLength(1)
  })

  test('returns sales-safe history in customer detail', async () => {
    const { db } = readDb()
    const response = await setupApp(db, { salesOnly: true }).request(
      '/api/sales-customers/friend/friend-1',
    )

    expect(response.status).toBe(200)
    const body = await response.json() as {
      data: {
        history: Array<Record<string, unknown>>
      }
    }
    expect(body.data).not.toHaveProperty('canEditStatus')
    expect(body.data.history).toEqual([{
      id: 'event-1',
      fromStatus: 'attention',
      toStatus: 'complaint',
      source: 'ai',
      actorName: '運営担当',
      createdAt: directRow.status_updated_at,
    }])
  })

  test('rejects unsafe identifiers and list limits', async () => {
    const { db } = readDb()
    const app = setupApp(db)
    expect((await app.request('/api/sales-customers?lineAccountId=bad%20id')).status).toBe(400)
    expect((await app.request('/api/sales-customers?lineAccountId=account-1&limit=101')).status).toBe(400)
    expect((await app.request('/api/sales-customers/person/friend-1')).status).toBe(400)
  })
})

function situationBatchDb() {
  const batches: Array<Array<{ sql: string; binds: unknown[] }>> = []
  type Statement = D1PreparedStatement & { __sql: string; __binds: unknown[] }
  const db = {
    prepare(sql: string) {
      const statement = {
        __sql: sql,
        __binds: [] as unknown[],
        bind(...values: unknown[]) {
          statement.__binds = values
          return statement
        },
        async all<T>() {
          if (sql.includes('FROM customer_subjects cs')) {
            if (sql.includes('AND cs.subject_kind = ?')) {
              const subjectKind = statement.__binds.at(-2)
              const subjectId = statement.__binds.at(-1)
              const selected = [directRow, groupRow].filter((row) => (
                row.subject_kind === subjectKind && row.subject_id === subjectId
              ))
              return { results: selected } as { results: T[] }
            }
            return { results: [directRow, groupRow] } as { results: T[] }
          }
          if (sql.includes('WITH ranked_messages') && sql.includes('FROM messages_log')) {
            return { results: [{
              subject_id: 'friend-1',
              direction: 'incoming',
              content: '田中商事の田中様から返品方法について相談。test@example.com',
              created_at: '2026-09-09T08:00:00+09:00',
              sender_name: null,
              sent_by_staff_name: null,
            }] } as { results: T[] }
          }
          if (sql.includes('WITH ranked_messages') && sql.includes('FROM line_conversation_messages')) {
            return { results: [{
              subject_id: 'conversation-1',
              direction: 'incoming',
              content: 'STAR FIELDの山田から商品の発送時期を確認したい。',
              created_at: '2026-09-09T09:00:00+09:00',
              sender_name: '山田太郎',
              sent_by_staff_name: null,
            }] } as { results: T[] }
          }
          return { results: [] } as { results: T[] }
        },
        async first<T>() {
          if (sql.includes('COUNT(*) AS count')) {
            if (sql.includes('subject_kind = ?')) {
              const subjectKind = statement.__binds.at(-2)
              const subjectId = statement.__binds.at(-1)
              return {
                count: [directRow, groupRow].filter((row) => (
                  row.subject_kind === subjectKind && row.subject_id === subjectId
                )).length,
              } as T
            }
            return { count: 2 } as T
          }
          return null
        },
      }
      return statement as unknown as Statement
    },
    async batch(statements: D1PreparedStatement[]) {
      batches.push((statements as Statement[]).map((statement) => ({
        sql: statement.__sql,
        binds: statement.__binds,
      })))
      return []
    },
  } as unknown as D1Database
  return { db, batches }
}

function situationAi() {
  const run = vi.fn().mockImplementation((_model: unknown, request: unknown) => {
    const isShipping = JSON.stringify(request).includes('発送時期');
    return Promise.resolve({
      response: JSON.stringify(isShipping ? {
        currentState: '商品の発送時期について回答待ちである。',
        recognizedStatus: 'attention',
        resolutionConfirmed: false,
        events: [{
          occurredAt: '2026-09-09T09:00:00+09:00',
          kind: 'customer_contact',
          title: '発送時期の確認依頼',
          detail: '顧客から商品の発送時期を確認したいとの連絡があった。',
          state: 'open',
        }],
      } : {
        currentState: '返品方法への苦情があり、担当の回答待ちである。',
        recognizedStatus: 'complaint',
        resolutionConfirmed: false,
        events: [{
          occurredAt: '2026-09-09T08:00:00+09:00',
          kind: 'customer_contact',
          title: '返品方法の苦情を受信',
          detail: '顧客から返品方法について苦情の連絡があった。',
          state: 'open',
        }],
      }),
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
  })
  return { ai: { run } as unknown as Ai, run }
}

describe('sales customer situation generation', () => {
  const body = (dryRun: boolean, confirm?: string) => JSON.stringify({
    lineAccountId: 'account-1',
    dryRun,
    limit: 5,
    offset: 0,
    confirm,
  })

  test('dry-runs an exact page without writing or touching statuses', async () => {
    const harness = situationBatchDb()
    const response = await setupApp(harness.db).request('/api/sales-customers/situations/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body(true),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        dryRun: true,
        total: 2,
        processed: 2,
        changes: { create: 1, update: 1, unchanged: 0 },
        estimate: { aiRequests: 2, noText: 0 },
        written: 0,
        historyEventsWritten: 0,
        statusRowsTouched: 0,
      },
    })
    expect(harness.batches).toHaveLength(0)
  })

  test('requires explicit confirmation, writes timelines, and automatically creates a changed status', async () => {
    const harness = situationBatchDb()
    const model = situationAi()
    const app = setupApp(harness.db, {}, model.ai)
    const rejected = await app.request('/api/sales-customers/situations/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(false),
    })
    expect(rejected.status).toBe(400)

    const response = await app.request('/api/sales-customers/situations/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body(false, 'generate_sales_customer_situations'),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: {
        written: 2,
        historyEventsWritten: 2,
        aiGenerated: 2,
        noTextWritten: 0,
        aiAttempts: 2,
        usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
        failed: 0,
        statusRowsTouched: 1,
        statusChanges: { created: 1, updated: 0, unchanged: 1, protected: 0, unreviewed: 0 },
      },
    })
    expect(harness.batches).toHaveLength(1)
    expect(harness.batches[0]).toHaveLength(6)
    const sql = harness.batches[0].map((statement) => statement.sql).join('\n')
    expect(sql).toContain('sales_customer_situation_timelines')
    expect(sql).toContain('sales_customer_situation_timeline_events')
    expect(sql).toContain('INSERT INTO sales_customer_statuses')
    expect(sql).toContain('INSERT INTO sales_customer_status_events')
    for (const statement of harness.batches[0]) {
      expect(statement.sql.match(/\?/g) ?? []).toHaveLength(statement.binds.length)
    }
    expect(JSON.stringify(harness.batches[0])).not.toContain('出力してはいけない会話')
    expect(JSON.stringify(harness.batches[0])).not.toContain('田中が返品')
    expect(JSON.stringify(harness.batches[0])).not.toContain('STAR FIELD')
    expect(JSON.stringify(harness.batches[0])).not.toContain('山田が商品')
    expect(model.run).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(model.run.mock.calls)).not.toContain('田中商事')
    expect(JSON.stringify(model.run.mock.calls)).not.toContain('test@example.com')
    expect(JSON.stringify(model.run.mock.calls)).not.toContain('STAR FIELD')
    expect(JSON.stringify(model.run.mock.calls)).not.toContain('山田から')
  })

  test('processes only the exact queued subject and validates the subject pair', async () => {
    const harness = situationBatchDb()
    const model = situationAi()
    const app = setupApp(harness.db, {}, model.ai)
    const response = await app.request('/api/sales-customers/situations/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'account-1',
        subjectKind: 'conversation',
        subjectId: 'conversation-1',
        dryRun: false,
        confirm: 'generate_sales_customer_situations',
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: {
        total: 1,
        offset: 0,
        limit: 1,
        processed: 1,
        hasNextPage: false,
        written: 1,
        aiGenerated: 1,
        statusRowsTouched: 1,
      },
    })
    expect(model.run).toHaveBeenCalledTimes(1)
    expect(harness.batches).toHaveLength(1)
    expect(harness.batches[0]).toHaveLength(4)
    expect(JSON.stringify(harness.batches[0])).not.toContain('返品方法')

    const incomplete = await app.request('/api/sales-customers/situations/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineAccountId: 'account-1',
        subjectKind: 'friend',
        dryRun: true,
      }),
    })
    expect(incomplete.status).toBe(400)
    expect(await incomplete.json()).toMatchObject({ error: 'exact_subject_requires_kind_and_id' })
  })

  test('rejects sales-only and secondary accounts', async () => {
    const harness = situationBatchDb()
    const request = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(true) }
    expect((await setupApp(harness.db, { salesOnly: true }).request('/api/sales-customers/situations/generate', request)).status).toBe(403)
    expect((await setupApp(harness.db, { role: 'secondary' }).request('/api/sales-customers/situations/generate', request)).status).toBe(403)
    expect(harness.batches).toHaveLength(0)
  })
})

type CurrentStatus = {
  id: string
  status: 'normal' | 'attention' | 'complaint' | 'exit_pending' | 'exited'
  summary: string
  version: number
  mutationId: string
  updatedByName: string
  updatedAt: string
}

function mutationDb(initial: CurrentStatus | null = null, subjectExists = true) {
  let current = initial
  const preparedSql: string[] = []
  const events: Array<{
    id: string
    from_status: string
    to_status: string
    summary: string
    source: 'manual' | 'ai'
    actor_name: string
    created_at: string
  }> = []
  type Statement = D1PreparedStatement & { __sql: string; __binds: unknown[] }
  const db = {
    prepare(sql: string) {
      preparedSql.push(sql)
      const statement = {
        __sql: sql,
        __binds: [] as unknown[],
        bind(...values: unknown[]) {
          statement.__binds = values
          return statement
        },
        async first<T>() {
          if (sql.includes('SELECT subject_id FROM customer_subjects')) {
            return subjectExists ? { subject_id: 'friend-1' } as T : null
          }
          if (sql.includes('FROM sales_customer_statuses') && sql.includes('SELECT id, status')) {
            return current ? {
              id: current.id,
              status: current.status,
              summary: current.summary,
              version: current.version,
            } as T : null
          }
          if (sql.includes('FROM customer_subjects cs')) {
            return {
              ...directRow,
              status_id: current?.id ?? null,
              sales_status: current?.status ?? 'unreviewed',
              status_source: current ? 'manual' : null,
              status_source_fingerprint: null,
              status_version: current?.version ?? null,
              status_updated_by_name: current?.updatedByName ?? null,
              status_updated_at: current?.updatedAt ?? null,
            } as T
          }
          return null
        },
        async all<T>() {
          if (sql.includes('FROM sales_customer_status_events')) {
            return { results: [...events].reverse() } as { results: T[] }
          }
          return { results: [] } as { results: T[] }
        },
      }
      return statement as unknown as Statement
    },
    async batch(statements: D1PreparedStatement[]) {
      const [statusStatement, eventStatement] = statements as Statement[]
      if (statusStatement.__sql.includes('INSERT INTO sales_customer_statuses')) {
        if (current) throw new Error('UNIQUE constraint failed: sales_customer_statuses.friend_id')
        const [id, , , status, summary, mutationId, , actorName, , updatedAt] = statusStatement.__binds
        current = {
          id: String(id),
          status: status as CurrentStatus['status'],
          summary: String(summary),
          version: 1,
          mutationId: String(mutationId),
          updatedByName: String(actorName),
          updatedAt: String(updatedAt),
        }
      } else {
        const [status, summary, mutationId, , actorName, updatedAt, id, expectedVersion] = statusStatement.__binds
        if (!current || current.id !== id || current.version !== expectedVersion) {
          throw new Error('NOT NULL constraint failed: sales_customer_status_events.status_id')
        }
        current = {
          ...current,
          status: status as CurrentStatus['status'],
          summary: String(summary),
          version: current.version + 1,
          mutationId: String(mutationId),
          updatedByName: String(actorName),
          updatedAt: String(updatedAt),
        }
      }
      const [id, mutationId, fromStatus, toStatus, summary, , actorName, createdAt] = eventStatement.__binds
      if (!current || current.mutationId !== mutationId) {
        throw new Error('NOT NULL constraint failed: sales_customer_status_events.status_id')
      }
      events.push({
        id: String(id),
        from_status: String(fromStatus),
        to_status: String(toStatus),
        summary: String(summary),
        source: 'manual',
        actor_name: String(actorName),
        created_at: String(createdAt),
      })
      return []
    },
  } as unknown as D1Database
  return { db, state: () => ({ current, events, preparedSql }) }
}

describe('sales customer status updates', () => {
  test('does not expose a manual status mutation route', async () => {
    const harness = mutationDb()
    const response = await setupApp(harness.db).request('/api/sales-customers/friend/friend-1/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'normal', expectedVersion: 0 }),
    })

    expect(response.status).toBe(404)
    expect(harness.state().current).toBeNull()
    expect(harness.state().events).toHaveLength(0)
  })

  test('logs only an error kind when a database read fails', async () => {
    const db = { prepare: vi.fn(() => { throw new Error('secret customer content') }) } as unknown as D1Database
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await setupApp(db).request('/api/sales-customers?lineAccountId=account-1')
      expect(response.status).toBe(500)
      const logged = errorSpy.mock.calls.flat().map(String).join(' ')
      expect(logged).toContain('GET /api/sales-customers error: Error')
      expect(logged).not.toContain('secret customer content')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
