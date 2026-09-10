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
  Bindings: { DB: D1Database }
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
  status_summary: string | null
  status_version: number | null
  status_updated_by_name: string | null
  status_updated_at: string | null
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
  status_summary: '契約内容を確認中。営業連絡は停止。',
  status_version: 2,
  status_updated_by_name: '運営担当',
  status_updated_at: '2026-09-09T10:00:00+09:00',
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
  customer_metadata: JSON.stringify({ customerNumber: 'C-002', companyName: '山田商店' }),
  status_id: null,
  sales_status: 'unreviewed',
  status_summary: null,
  status_version: null,
  status_updated_by_name: null,
  status_updated_at: null,
  is_following: null,
  chat_status: 'resolved',
}

function setupApp(db: D1Database, staff: Partial<TestStaff> = {}) {
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
    c.env = { DB: db }
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
                summary: directRow.status_summary,
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
      data: { items: Array<Record<string, unknown>>; counts: Record<string, number>; canEditStatus: boolean }
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
      isFollowing: true,
      chatStatus: 'in_progress',
      activity: {
        needsHumanReply: true,
        windows: {
          oneMonth: {
            totalMessages: 12,
            customerMessages: 5,
            staffReplies: 4,
            automatedMessages: 3,
          },
          threeMonths: { totalMessages: 24 },
        },
        support: { activeCases: 1, casesInThreeMonths: 2 },
      },
    })
    expect(body.data.items[1]).toMatchObject({
      subjectKind: 'conversation',
      sourceKind: 'group',
      companyName: '山田商店',
      status: 'unreviewed',
      version: 0,
    })
    expect(body.data.canEditStatus).toBe(false)
    expect(body.data.counts).toMatchObject({ complaint: 1, unreviewed: 1, normal: 0 })
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('privateConversation')
    expect(serialized).not.toContain('出力してはいけない会話')
    expect(serialized).not.toContain('customer_metadata')
    expect(serialized).not.toContain('sender_user_id')
    expect(calls.some((call) => call.sql.includes("source_type IN ('group', 'room')"))).toBe(true)
    const activityCall = calls.find((call) => call.sql.includes('customer_message_activity'))
    expect(activityCall?.sql).not.toMatch(/\bml\.content\b|\blcm\.content\b/)
    expect(activityCall?.binds.slice(0, 3)).toEqual(['account-1', 'account-1', 'account-1'])
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
      data: { history: Array<Record<string, unknown>>; canEditStatus: boolean }
    }
    expect(body.data.canEditStatus).toBe(false)
    expect(body.data.history).toEqual([{
      id: 'event-1',
      fromStatus: 'attention',
      toStatus: 'complaint',
      summary: directRow.status_summary,
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
              status_summary: current?.summary ?? null,
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
        actor_name: String(actorName),
        created_at: String(createdAt),
      })
      return []
    },
  } as unknown as D1Database
  return { db, state: () => ({ current, events, preparedSql }) }
}

describe('sales customer status updates', () => {
  test('creates and then version-updates current state with immutable history', async () => {
    const harness = mutationDb()
    const app = setupApp(harness.db)

    const first = await app.request('/api/sales-customers/friend/friend-1/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'complaint', summary: ' 営業連絡を停止 ', expectedVersion: 0 }),
    })
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({
      success: true,
      data: { status: 'complaint', summary: '営業連絡を停止', version: 1 },
    })

    const second = await app.request('/api/sales-customers/friend/friend-1/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'normal', summary: '解決済み。通常対応可。', expectedVersion: 1 }),
    })
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({
      success: true,
      data: { status: 'normal', summary: '解決済み。通常対応可。', version: 2 },
    })
    expect(harness.state().events.map((event) => [event.from_status, event.to_status])).toEqual([
      ['unreviewed', 'complaint'],
      ['complaint', 'normal'],
    ])
    expect(harness.state().preparedSql.some((sql) => (
      sql.includes('SELECT subject_id FROM customer_subjects')
      && sql.includes('INNER JOIN line_accounts')
      && sql.includes("source_type IN ('group', 'room')")
    ))).toBe(true)

    const detail = await app.request('/api/sales-customers/friend/friend-1')
    const detailBody = await detail.json() as { data: { history: Array<{ toStatus: string }> } }
    expect(detailBody.data.history.map((event) => event.toStatus)).toEqual(['normal', 'complaint'])
  })

  test('requires operator permission, a summary, and the current version', async () => {
    const harness = mutationDb({
      id: 'status-1',
      status: 'attention',
      summary: '要確認',
      version: 3,
      mutationId: 'mutation-old',
      updatedByName: '運営担当',
      updatedAt: '2026-09-09T10:00:00+09:00',
    })
    const payload = JSON.stringify({ status: 'normal', summary: '解決済み', expectedVersion: 2 })

    const conflict = await setupApp(harness.db).request('/api/sales-customers/friend/friend-1/status', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: payload,
    })
    expect(conflict.status).toBe(409)

    const blank = await setupApp(harness.db).request('/api/sales-customers/friend/friend-1/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'normal', summary: '   ', expectedVersion: 3 }),
    })
    expect(blank.status).toBe(400)

    const salesOnly = await setupApp(harness.db, { salesOnly: true }).request('/api/sales-customers/friend/friend-1/status', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: payload,
    })
    expect(salesOnly.status).toBe(403)

    const secondary = await setupApp(harness.db, { role: 'secondary' }).request('/api/sales-customers/friend/friend-1/status', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: payload,
    })
    expect(secondary.status).toBe(403)
  })

  test('redacts obvious contact details before storing a sales-facing overview', async () => {
    const harness = mutationDb()
    const response = await setupApp(harness.db).request('/api/sales-customers/friend/friend-1/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'attention',
        summary: '連絡先は 090-1234-5678 / 09012345678 / +81 90 1234 5678 / person@example.com / https://example.com/private を参照',
        expectedVersion: 0,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { data: { summary: string } }
    expect(body.data.summary).toContain('[電話番号非表示]')
    expect(body.data.summary).toContain('[メール非表示]')
    expect(body.data.summary).toContain('[URL非表示]')
    expect(body.data.summary).not.toContain('090-1234-5678')
    expect(body.data.summary).not.toContain('09012345678')
    expect(body.data.summary).not.toContain('+81 90 1234 5678')
    expect(body.data.summary).not.toContain('person@example.com')
    expect(body.data.summary).not.toContain('example.com/private')
  })

  test('does not update inactive or out-of-scope customer subjects', async () => {
    const harness = mutationDb(null, false)
    const response = await setupApp(harness.db).request('/api/sales-customers/friend/friend-1/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'normal', summary: '通常対応可', expectedVersion: 0 }),
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
