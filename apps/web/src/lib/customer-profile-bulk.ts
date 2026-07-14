import {
  customerOperationContractFieldDefinitions,
  customerProfileFieldDefinitions,
  emptyCustomerOperationContract,
  type CustomerOperationContract,
  type CustomerOperationContractFieldKey,
  type CustomerProfileFieldKey,
} from './customer-profile'

export type CustomerProfileBulkRow = {
  friendId?: string
  lineUserId?: string
  metadata: Record<string, unknown> & { operationContracts?: CustomerOperationContract[] }
}

export type CustomerProfileBulkParseResult = {
  rows: CustomerProfileBulkRow[]
  issues: string[]
}

const identifierHeaders = new Map<string, 'friendId' | 'lineUserId'>([
  ['friendid', 'friendId'],
  ['friend_id', 'friendId'],
  ['id', 'friendId'],
  ['lineuserid', 'lineUserId'],
  ['line_user_id', 'lineUserId'],
  ['lineid', 'lineUserId'],
  ['line_id', 'lineUserId'],
])

const profileHeaderMap = new Map<string, CustomerProfileFieldKey>(
  customerProfileFieldDefinitions.flatMap((field) => [
    [normalizeHeader(field.key), field.key],
    ...field.aliases.map((alias) => [normalizeHeader(alias), field.key] as const),
  ]),
)

const operationFieldKeys = new Set<CustomerProfileFieldKey>(
  customerOperationContractFieldDefinitions.map((field) => field.key),
)

const broadcastExclusionHeaders = new Set([
  'broadcastexcluded',
  'broadcast_excluded',
  'donotbroadcast',
  'do_not_broadcast',
  'nobroadcast',
  'no_broadcast',
  'sendpaused',
  'send_paused',
  'deliverystopped',
  'delivery_stopped',
  'excludedfrombroadcast',
  'broadcastoptout',
  'broadcast_opt_out',
  '配信除外',
  '一斉送信除外',
])

function normalizeHeader(value: string): string {
  return value.trim().replace(/^\uFEFF/, '').replace(/[\s-]/g, '').toLowerCase()
}

function splitLine(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((cell) => cell.trim())
}

function parseBroadcastExcludedCell(value: string): boolean | null | undefined {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return undefined
  if (['1', 'true', 'yes', 'on', '除外', '対象外', '停止', '配信停止', '配信しない', '一斉送信除外'].includes(normalized)) {
    return true
  }
  if (['0', 'false', 'no', 'off', '解除', '対象', '配信する', '配信可', 'しない'].includes(normalized)) {
    return false
  }
  return null
}

export function parseCustomerProfileBulkText(input: string): CustomerProfileBulkParseResult {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return { rows: [], issues: [] }
  if (lines.length === 1) return { rows: [], issues: ['ヘッダー行の下に更新したい顧客情報を貼り付けてください。'] }

  const delimiter = lines[0].includes('\t') ? '\t' : ','
  const headers = splitLine(lines[0], delimiter)
  const mappedHeaders = headers.map((header) => {
    const normalized = normalizeHeader(header)
    return identifierHeaders.get(normalized)
      ?? profileHeaderMap.get(normalized)
      ?? (broadcastExclusionHeaders.has(normalized) ? 'broadcastExcluded' : null)
  })

  if (!mappedHeaders.includes('friendId') && !mappedHeaders.includes('lineUserId')) {
    return { rows: [], issues: ['friendId か lineUserId の列が必要です。'] }
  }

  const rows: CustomerProfileBulkRow[] = []
  const issues: string[] = []

  lines.slice(1).forEach((line, index) => {
    const cells = splitLine(line, delimiter)
    const metadata: CustomerProfileBulkRow['metadata'] = {}
    const operationContract = emptyCustomerOperationContract()
    let friendId = ''
    let lineUserId = ''
    let hasProfileValue = false
    let invalidBroadcastExcluded = false

    mappedHeaders.forEach((key, cellIndex) => {
      if (!key) return
      const value = cells[cellIndex]?.trim() ?? ''
      if (key === 'friendId') friendId = value
      else if (key === 'lineUserId') lineUserId = value
      else if (key === 'broadcastExcluded') {
        const parsed = parseBroadcastExcludedCell(value)
        if (parsed === null) {
          invalidBroadcastExcluded = true
          return
        }
        if (parsed !== undefined) {
          metadata.broadcastExcluded = parsed
          hasProfileValue = true
        }
      }
      else {
        if (operationFieldKeys.has(key)) {
          operationContract[key as CustomerOperationContractFieldKey] = value
        } else {
          metadata[key] = value
        }
        if (value) hasProfileValue = true
      }
    })

    const rowNumber = index + 2
    if (!friendId && !lineUserId) {
      issues.push(`${rowNumber}行目: friendId か lineUserId を入れてください。`)
      return
    }
    if (invalidBroadcastExcluded) {
      issues.push(`${rowNumber}行目: 一斉送信除外は true/false、除外/解除 などで入力してください。`)
      return
    }
    if (!hasProfileValue) {
      issues.push(`${rowNumber}行目: 更新する顧客情報がありません。`)
      return
    }
    if (customerOperationContractFieldDefinitions.some((field) => operationContract[field.key as CustomerOperationContractFieldKey].trim())) {
      metadata.operationContracts = [operationContract]
      metadata.shopName = operationContract.shopName
      metadata.storeName = operationContract.shopName
      metadata.handoverDate = operationContract.handoverDate
      metadata.minimumGuaranteeStartMonth = operationContract.minimumGuaranteeStartMonth
      metadata.minimumGuarantee = operationContract.minimumGuaranteeStartMonth
      metadata.closedAt = operationContract.closedAt
    }
    rows.push({
      ...(friendId ? { friendId } : {}),
      ...(lineUserId ? { lineUserId } : {}),
      metadata,
    })
  })

  return { rows, issues }
}
