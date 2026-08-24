export type InternalTaskPage<T> = {
  data: T[]
  meta?: { total: number; hasMore: boolean }
}

export async function loadAllInternalTaskPages<T extends { id: string }>(
  fetchPage: (offset: number, limit: number) => Promise<InternalTaskPage<T>>,
  options: { pageSize?: number; maxPasses?: number; maxPagesPerPass?: number } = {},
): Promise<{ items: T[]; total: number; complete: boolean }> {
  const pageSize = options.pageSize ?? 100
  const maxPasses = options.maxPasses ?? 3
  const maxPagesPerPass = options.maxPagesPerPass ?? 100
  const merged = new Map<string, T>()
  let latestOrder: string[] = []
  let latestTotal = 0

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let offset = 0
    let pageCount = 0
    const passOrder: string[] = []
    while (pageCount < maxPagesPerPass) {
      const page = await fetchPage(offset, pageSize)
      pageCount += 1
      latestTotal = page.meta?.total ?? Math.max(latestTotal, offset + page.data.length)
      for (const item of page.data) {
        merged.set(item.id, item)
        if (!passOrder.includes(item.id)) passOrder.push(item.id)
      }
      if (!(page.meta?.hasMore ?? page.data.length === pageSize) || page.data.length === 0) break
      offset += page.data.length
    }
    latestOrder = passOrder
    if (merged.size >= latestTotal) {
      const ordered = [...latestOrder, ...[...merged.keys()].filter((id) => !latestOrder.includes(id))]
      return { items: ordered.map((id) => merged.get(id)!), total: latestTotal, complete: true }
    }
  }

  const ordered = [...latestOrder, ...[...merged.keys()].filter((id) => !latestOrder.includes(id))]
  return { items: ordered.map((id) => merged.get(id)!), total: latestTotal, complete: false }
}
