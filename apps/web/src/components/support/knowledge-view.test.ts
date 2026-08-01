import { describe, expect, it } from 'vitest'
import type { SupportManual } from '@/lib/api'
import {
  KNOWLEDGE_BATCH_SIZE,
  getKnowledgeCategoryCounts,
  getKnowledgeManuals,
  getKnowledgeViewCounts,
} from './knowledge-view'

function manual(overrides: Partial<SupportManual>): SupportManual {
  return {
    id: 'manual-1',
    lineAccountId: 'account-1',
    title: '問い合わせ',
    category: 'other',
    body: '',
    url: null,
    keywords: '',
    owner: null,
    approvedBy: null,
    revisedAt: null,
    isActive: true,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    question: 'どう対応しますか',
    resolution: 'このように案内します',
    procedure: '',
    applicability: '',
    cautions: '',
    sourceBody: '',
    knowledgeStatus: 'ready',
    qualityScore: 90,
    reviewNote: '',
    useCount: 0,
    lastUsedAt: null,
    helpfulCount: 0,
    needsImprovementCount: 0,
    ...overrides,
  }
}

describe('knowledge work view', () => {
  const manuals = [
    manual({ id: 'verified', category: 'delivery', knowledgeStatus: 'verified' }),
    manual({ id: 'ready', category: 'delivery', knowledgeStatus: 'ready' }),
    manual({ id: 'review', category: 'reward', knowledgeStatus: 'needs_review' }),
    manual({ id: 'unresolved', category: 'other', knowledgeStatus: 'unresolved' }),
  ]

  it('puts both verified answers and usable answer candidates in the default work view', () => {
    expect(getKnowledgeManuals(manuals, 'use').map((item) => item.id)).toEqual(['verified', 'ready'])
  })

  it('keeps confirmation and cleanup work in their own views', () => {
    expect(getKnowledgeViewCounts(manuals)).toEqual({ use: 2, candidates: 1, review: 2 })
  })

  it('filters the current view by category and reports category totals', () => {
    expect(getKnowledgeManuals(manuals, 'use', 'delivery')).toHaveLength(2)
    expect(getKnowledgeManuals(manuals, 'use', 'reward')).toHaveLength(0)
    expect(getKnowledgeCategoryCounts(manuals, 'use')).toEqual({ delivery: 2 })
  })

  it('uses a bounded initial batch for large knowledge collections', () => {
    expect(KNOWLEDGE_BATCH_SIZE).toBe(40)
  })
})
