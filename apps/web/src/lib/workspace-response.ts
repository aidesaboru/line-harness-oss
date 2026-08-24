export interface WorkspaceSnapshot {
  accountId: string | null
  version: number
}

export function isWorkspaceSnapshotCurrent(
  request: WorkspaceSnapshot,
  current: WorkspaceSnapshot,
): boolean {
  return request.accountId === current.accountId && request.version === current.version
}

export function canApplyWorkspaceEntityResponse(
  request: WorkspaceSnapshot & { entityId: string },
  current: WorkspaceSnapshot & { entityId: string | null },
  responseEntityId: string,
): boolean {
  return request.entityId === responseEntityId
    && current.entityId === responseEntityId
    && isWorkspaceSnapshotCurrent(request, current)
}
