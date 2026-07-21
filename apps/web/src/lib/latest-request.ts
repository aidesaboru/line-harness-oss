export interface LatestRequestGate {
  start: () => number
  isLatest: (requestId: number) => boolean
  invalidate: () => void
}

export function createLatestRequestGate(): LatestRequestGate {
  let latestRequestId = 0

  return {
    start() {
      latestRequestId += 1
      return latestRequestId
    },
    isLatest(requestId) {
      return requestId === latestRequestId
    },
    invalidate() {
      latestRequestId += 1
    },
  }
}

export function shouldResetForAccountChange(
  hasRestoredInitialAccount: boolean,
  previousAccountId: string | null,
  nextAccountId: string | null,
): boolean {
  return hasRestoredInitialAccount && previousAccountId !== nextAccountId
}
