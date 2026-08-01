import type { SupportManual } from '@/lib/api'

export type KnowledgeView = 'use' | 'candidates' | 'review'

export const KNOWLEDGE_BATCH_SIZE = 40

export const knowledgeStatuses: Record<KnowledgeView, SupportManual['knowledgeStatus'][]> = {
  use: ['verified', 'ready'],
  candidates: ['ready'],
  review: ['needs_review', 'unresolved'],
}

export function getKnowledgeManuals(
  manuals: SupportManual[],
  view: KnowledgeView,
  category = 'all',
): SupportManual[] {
  const statuses = knowledgeStatuses[view]
  return manuals.filter((manual) => (
    statuses.includes(manual.knowledgeStatus)
    && (category === 'all' || manual.category === category)
  ))
}

export function getKnowledgeViewCounts(manuals: SupportManual[]): Record<KnowledgeView, number> {
  return {
    use: getKnowledgeManuals(manuals, 'use').length,
    candidates: getKnowledgeManuals(manuals, 'candidates').length,
    review: getKnowledgeManuals(manuals, 'review').length,
  }
}

export function getKnowledgeCategoryCounts(
  manuals: SupportManual[],
  view: KnowledgeView,
): Record<string, number> {
  return getKnowledgeManuals(manuals, view).reduce<Record<string, number>>((counts, manual) => {
    counts[manual.category] = (counts[manual.category] ?? 0) + 1
    return counts
  }, {})
}
