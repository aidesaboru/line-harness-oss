export type CustomerProfileFieldKey =
  | 'customerNumber'
  | 'companyName'
  | 'contactName'
  | 'storeName'
  | 'handoverDate'
  | 'contractType'
  | 'closingMonth'
  | 'minimumGuarantee'
  | 'googleFolderUrl'
  | 'stores'

export type CustomerProfileField = {
  key: CustomerProfileFieldKey
  label: string
  value: string
  required: boolean
  missing: boolean
}

export type CustomerProfile = {
  fields: CustomerProfileField[]
  requiredFields: CustomerProfileField[]
  missingRequiredFields: CustomerProfileField[]
  completedRequiredCount: number
  totalRequiredCount: number
  completionLabel: string
  displayName: string | null
  primaryLine: string
  secondaryLine: string
  broadcastExcluded: boolean
}

type FieldDefinition = {
  key: CustomerProfileFieldKey
  label: string
  required: boolean
  aliases: string[]
}

export type CustomerProfileFieldGroup = {
  title: string
  description: string
  keys: CustomerProfileFieldKey[]
}

export const customerProfileFieldDefinitions: FieldDefinition[] = [
  {
    key: 'customerNumber',
    label: '顧客番号',
    required: true,
    aliases: ['customerNumber', 'customer_number', 'customerNo', 'customer_no', 'clientNumber', 'client_number'],
  },
  {
    key: 'companyName',
    label: '法人名',
    required: true,
    aliases: ['companyName', 'company_name', 'company', 'corporationName', 'corporation_name', 'customerName', 'customer_name', 'clientName', 'client_name'],
  },
  {
    key: 'contactName',
    label: '顧客名',
    required: true,
    aliases: ['contactName', 'contact_name', 'personInCharge', 'person_in_charge', 'managerName', 'manager_name', '顧客名', '連絡者名', '担当者名'],
  },
  {
    key: 'storeName',
    label: '店舗名',
    required: true,
    aliases: ['storeName', 'store_name', 'shopName', 'shop_name', 'mainStoreName', 'main_store_name'],
  },
  {
    key: 'handoverDate',
    label: '引き継ぎ日',
    required: false,
    aliases: ['handoverDate', 'handover_date', 'handoffDate', 'handoff_date', 'transferDate', 'transfer_date'],
  },
  {
    key: 'contractType',
    label: '契約内容',
    required: false,
    aliases: ['contractType', 'contract_type', 'contractPlan', 'contract_plan', 'plan', '契約内容'],
  },
  {
    key: 'closingMonth',
    label: '決算月',
    required: false,
    aliases: ['closingMonth', 'closing_month', 'fiscalClosingMonth', 'fiscal_closing_month', 'fiscalMonth', 'fiscal_month', 'settlementMonth', 'settlement_month', '決算月'],
  },
  {
    key: 'minimumGuarantee',
    label: '最低保証開始月',
    required: false,
    aliases: ['minimumGuarantee', 'minimum_guarantee', 'minimumGuaranteeStartMonth', 'minimum_guarantee_start_month', 'minimumGuaranteeAmount', 'minimum_guarantee_amount', 'guarantee', '最低保証開始月', '最低保証'],
  },
  {
    key: 'googleFolderUrl',
    label: 'GoogleフォルダURL',
    required: false,
    aliases: ['googleFolderUrl', 'google_folder_url', 'googleDriveFolderUrl', 'google_drive_folder_url', 'driveFolderUrl', 'drive_folder_url', 'folderUrl', 'folder_url', 'googleFolder', 'google_folder', 'GoogleフォルダURL', 'Googleフォルダ', 'googleフォルダurl'],
  },
  {
    key: 'stores',
    label: '複数店舗メモ',
    required: false,
    aliases: ['stores', 'storeNames', 'store_names', 'multipleStores', 'multiple_stores', '複数店舗メモ'],
  },
]

export const customerProfileFieldGroups: CustomerProfileFieldGroup[] = [
  {
    title: '基本情報',
    description: '顧客を識別するための情報',
    keys: ['customerNumber', 'companyName', 'contactName', 'storeName'],
  },
  {
    title: '契約・運用情報',
    description: '引き継ぎや運用で確認する情報',
    keys: ['handoverDate', 'contractType', 'closingMonth', 'minimumGuarantee', 'googleFolderUrl', 'stores'],
  },
]

const profileMetadataKeys = new Set(
  customerProfileFieldDefinitions.flatMap((field) => [field.key, ...field.aliases]),
)

export const broadcastExclusionMetadataKeys = [
  'broadcastExcluded',
  'broadcast_excluded',
  'doNotBroadcast',
  'do_not_broadcast',
  'noBroadcast',
  'no_broadcast',
  'sendPaused',
  'send_paused',
  'deliveryStopped',
  'delivery_stopped',
  'stopped',
  'isStopped',
]

broadcastExclusionMetadataKeys.forEach((key) => profileMetadataKeys.add(key))

function normalizeMetadataValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeMetadataValue(item))
      .filter(Boolean)
      .join('、')
  }
  return ''
}

function readProfileValue(metadata: Record<string, unknown>, aliases: string[]): string {
  for (const key of aliases) {
    const value = normalizeMetadataValue(metadata[key])
    if (value) return value
  }
  return ''
}

function isTruthyMetadataValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function isCustomerBroadcastExcluded(metadata: Record<string, unknown> | null | undefined): boolean {
  const source = metadata ?? {}
  return broadcastExclusionMetadataKeys.some((key) => isTruthyMetadataValue(source[key]))
}

export function customerBroadcastExclusionPatch(excluded: boolean): Record<string, boolean> {
  return { broadcastExcluded: excluded }
}

export function customerProfileFromMetadata(metadata: Record<string, unknown> | null | undefined): CustomerProfile {
  const source = metadata ?? {}
  const fields = customerProfileFieldDefinitions.map((definition) => {
    const value = readProfileValue(source, [definition.key, ...definition.aliases])
    return {
      key: definition.key,
      label: definition.label,
      value,
      required: definition.required,
      missing: definition.required && !value,
    }
  })
  const requiredFields = fields.filter((field) => field.required)
  const missingRequiredFields = requiredFields.filter((field) => field.missing)
  const completedRequiredCount = requiredFields.length - missingRequiredFields.length
  const company = fields.find((field) => field.key === 'companyName')?.value ?? ''
  const store = fields.find((field) => field.key === 'storeName')?.value ?? ''
  const number = fields.find((field) => field.key === 'customerNumber')?.value ?? ''
  const contact = fields.find((field) => field.key === 'contactName')?.value ?? ''

  return {
    fields,
    requiredFields,
    missingRequiredFields,
    completedRequiredCount,
    totalRequiredCount: requiredFields.length,
    completionLabel: `${completedRequiredCount}/${requiredFields.length}`,
    displayName: number && contact ? `${number}_${contact}` : null,
    primaryLine: [company, store].filter(Boolean).join(' / '),
    secondaryLine: [number, contact].filter(Boolean).join(' / '),
    broadcastExcluded: isCustomerBroadcastExcluded(source),
  }
}

export function customerProfileFormFromMetadata(metadata: Record<string, unknown> | null | undefined): Record<CustomerProfileFieldKey, string> {
  const profile = customerProfileFromMetadata(metadata)
  return Object.fromEntries(profile.fields.map((field) => [field.key, field.value])) as Record<CustomerProfileFieldKey, string>
}

export function customerProfileMetadataPatch(form: Record<CustomerProfileFieldKey, string>): Record<string, string> {
  return Object.fromEntries(
    customerProfileFieldDefinitions.map((field) => [field.key, form[field.key]?.trim() ?? '']),
  )
}

export function isCustomerProfileMetadataKey(key: string): boolean {
  return profileMetadataKeys.has(key)
}
