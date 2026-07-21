import { describe, expect, it } from 'vitest'
import { createLatestRequestGate, shouldResetForAccountChange } from './latest-request'

describe('createLatestRequestGate', () => {
  it('allows only the newest request to update state', () => {
    const gate = createLatestRequestGate()
    const requestA = gate.start()
    const requestB = gate.start()
    const applied: string[] = []

    if (gate.isLatest(requestB)) applied.push('B')
    if (gate.isLatest(requestA)) applied.push('A')

    expect(applied).toEqual(['B'])
  })

  it('rejects an in-flight request after invalidation', () => {
    const gate = createLatestRequestGate()
    const request = gate.start()

    gate.invalidate()

    expect(gate.isLatest(request)).toBe(false)
  })
})

describe('shouldResetForAccountChange', () => {
  it('preserves a deep link during the initial restored account selection', () => {
    expect(shouldResetForAccountChange(false, null, 'account-a')).toBe(false)
  })

  it('resets the workspace when the operator actually switches accounts', () => {
    expect(shouldResetForAccountChange(true, 'account-a', 'account-b')).toBe(true)
  })

  it('resets the workspace when the restored account becomes unavailable', () => {
    expect(shouldResetForAccountChange(true, 'account-a', null)).toBe(true)
  })
})
