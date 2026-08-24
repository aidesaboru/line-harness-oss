import { describe, expect, test } from 'vitest'
import { loadAllInternalTaskPages } from './internal-task-pagination'

describe('internal task complete pagination', () => {
  test('reconciles an OFFSET boundary when a first-page task moves during loading', async () => {
    const original = Array.from({ length: 101 }, (_, index) => ({ id: `task-${index + 1}` }))
    const moved = [...original.slice(1), original[0]]
    let calls = 0
    const result = await loadAllInternalTaskPages(async (offset, limit) => {
      calls += 1
      const source = calls === 1 ? original : moved
      const data = source.slice(offset, offset + limit)
      return { data, meta: { total: source.length, hasMore: offset + data.length < source.length } }
    })

    expect(result.complete).toBe(true)
    expect(result.items).toHaveLength(101)
    expect(new Set(result.items.map((item) => item.id)).size).toBe(101)
    expect(calls).toBeGreaterThan(2)
  })

  test('reports incomplete data instead of silently hiding missing tasks', async () => {
    const result = await loadAllInternalTaskPages(async () => ({
      data: [{ id: 'task-1' }],
      meta: { total: 2, hasMore: false },
    }), { maxPasses: 2 })
    expect(result).toMatchObject({ total: 2, complete: false })
  })
})
