export type CustomerProfileFieldKey =
  | 'customerNumber'
  | 'companyName'
  | 'contactName'
  | 'googleFolderUrl'
  | 'closingMonth'
  | 'specialNotes'
  | 'shopName'
  | 'handoverDate'
  | 'minimumGuaranteeStartMonth'
  | 'closedAt'

export type CustomerProfileBasicFieldKey =
  | 'customerNumber'
  | 'companyName'
  | 'contactName'
  | 'googleFolderUrl'
  | 'closingMonth'
  | 'specialNotes'

export type CustomerOperationContractFieldKey =
  | 'shopName'
  | 'handoverDate'
  | 'minimumGuaranteeStartMonth'
  | 'closedAt'

export type CustomerProfileField = {
  key: CustomerProfileFieldKey
  label: string
  value: string
  required: boolean
  missing: boolean
}

export type CustomerProfile = {
  fields: CustomerProfileField[]
  basicFields: CustomerProfileField[]
  operationContracts: CustomerOperationContract[]
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

type FieldDefinition<K extends CustomerProfileFieldKey = CustomerProfileFieldKey> = {
  key: K
  label: string
  required: boolean
  aliases: string[]
}

export type CustomerProfileFieldGroup = {
  title: string
  description: string
  keys: CustomerProfileFieldKey[]
}

export type CustomerOperationContract = Record<CustomerOperationContractFieldKey, string>

export type CustomerProfileForm = {
  basic: Record<CustomerProfileBasicFieldKey, string>
  operationContracts: CustomerOperationContract[]
}

export const emptyCustomerOperationContract = (): CustomerOperationContract => ({
  shopName: '',
  handoverDate: '',
  minimumGuaranteeStartMonth: '',
  closedAt: '',
})

export const customerProfileBasicFieldDefinitions: FieldDefinition<CustomerProfileBasicFieldKey>[] = [
  {
    key: 'customerNumber',
    label: '顧客番号',
    required: true,
    aliases: ['customerNumber', 'customer_number', 'customerNo', 'customer_no', 'clientNumber', 'client_number', '顧客番号'],
  },
  {
    key: 'companyName',
    label: '法人名',
    required: true,
    aliases: ['companyName', 'company_name', 'company', 'corporationName', 'corporation_name', 'customerName', 'customer_name', 'clientName', 'client_name', '法人名'],
  },
  {
    key: 'contactName',
    label: '顧客名',
    required: true,
    aliases: ['contactName', 'contact_name', 'personInCharge', 'person_in_charge', 'managerName', 'manager_name', 'representativeName', 'representative_name', '顧客名', '連絡者名', '担当者名', '法人代表者名'],
  },
  {
    key: 'googleFolderUrl',
    label: 'GoogleフォルダーURL',
    required: false,
    aliases: ['googleFolderUrl', 'google_folder_url', 'googleDriveFolderUrl', 'google_drive_folder_url', 'driveFolderUrl', 'drive_folder_url', 'folderUrl', 'folder_url', 'googleFolder', 'google_folder', 'GoogleフォルダURL', 'GoogleフォルダーURL', 'Googleフォルダ', 'googleフォルダurl'],
  },
  {
    key: 'closingMonth',
    label: '決算月',
    required: false,
    aliases: ['closingMonth', 'closing_month', 'fiscalClosingMonth', 'fiscal_closing_month', 'fiscalMonth', 'fiscal_month', 'settlementMonth', 'settlement_month', '決算月'],
  },
  {
    key: 'specialNotes',
    label: '特記事項',
    required: false,
    aliases: ['specialNotes', 'special_notes', 'notes', 'note', 'remarks', 'remark', 'importantNotes', 'important_notes', '特記事項', '備考', 'メモ'],
  },
]

export const customerOperationContractFieldDefinitions: FieldDefinition<CustomerOperationContractFieldKey>[] = [
  {
    key: 'shopName',
    label: 'ショップ名',
    required: false,
    aliases: ['shopName', 'shop_name', 'storeName', 'store_name', 'mainStoreName', 'main_store_name', '店舗名', 'ショップ名'],
  },
  {
    key: 'handoverDate',
    label: '引き継ぎ日',
    required: false,
    aliases: ['handoverDate', 'handover_date', 'handoffDate', 'handoff_date', 'transferDate', 'transfer_date', '引き継ぎ日', '引継ぎ日', '引継日'],
  },
  {
    key: 'minimumGuaranteeStartMonth',
    label: '最低保証開始月',
    required: false,
    aliases: ['minimumGuaranteeStartMonth', 'minimum_guarantee_start_month', 'minimumGuarantee', 'minimum_guarantee', 'minimumGuaranteeAmount', 'minimum_guarantee_amount', 'guarantee', '最低保証開始月', '最低保証'],
  },
  {
    key: 'closedAt',
    label: '閉店日時',
    required: false,
    aliases: ['closedAt', 'closed_at', 'closedDateTime', 'closed_date_time', 'closedDate', 'closed_date', 'storeClosedAt', 'store_closed_at', '閉店日時', '閉店日'],
  },
]

export const customerProfileFieldDefinitions: FieldDefinition[] = [
  ...customerProfileBasicFieldDefinitions,
  ...customerOperationContractFieldDefinitions,
]

export const customerProfileFieldGroups: CustomerProfileFieldGroup[] = [
  {
    title: '基本情報',
    description: '顧客を識別し、参照先をすぐ開くための情報',
    keys: ['customerNumber', 'companyName', 'contactName', 'googleFolderUrl', 'closingMonth', 'specialNotes'],
  },
  {
    title: '運用契約情報',
    description: 'ショップごとに引き継ぎ日や保証開始月を管理します',
    keys: ['shopName', 'handoverDate', 'minimumGuaranteeStartMonth', 'closedAt'],
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
;[
  'operationContracts',
  'operation_contracts',
  'contractStores',
  'contract_stores',
  'storeName',
  'store_name',
  'minimumGuarantee',
  'minimum_guarantee',
].forEach((key) => profileMetadataKeys.add(key))

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

function parseJsonArray(value: string): unknown[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeOperationContract(raw: unknown): CustomerOperationContract {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCustomerOperationContract()
  const source = raw as Record<string, unknown>
  return Object.fromEntries(
    customerOperationContractFieldDefinitions.map((definition) => [
      definition.key,
      readProfileValue(source, [definition.key, ...definition.aliases]),
    ]),
  ) as CustomerOperationContract
}

function operationContractHasValue(contract: CustomerOperationContract): boolean {
  return customerOperationContractFieldDefinitions.some((definition) => contract[definition.key].trim())
}

function readOperationContracts(source: Record<string, unknown>): CustomerOperationContract[] {
  const rawContracts = source.operationContracts ?? source.operation_contracts ?? source.contractStores ?? source.contract_stores
  const parsedContracts = typeof rawContracts === 'string'
    ? parseJsonArray(rawContracts)
    : Array.isArray(rawContracts)
      ? rawContracts
      : null

  const contracts = (parsedContracts ?? [])
    .map((item) => normalizeOperationContract(item))
    .filter(operationContractHasValue)

  if (contracts.length > 0) return contracts

  const legacyFirst = normalizeOperationContract(source)
  const rawStores = source.stores ?? source.storeNames ?? source.store_names ?? source.multipleStores ?? source.multiple_stores
  const storeNames = Array.isArray(rawStores)
    ? rawStores.map((item) => normalizeMetadataValue(item)).filter(Boolean)
    : typeof rawStores === 'string'
      ? rawStores.split(/[,\n、]/).map((item) => item.trim()).filter(Boolean)
      : []

  if (!operationContractHasValue(legacyFirst) && storeNames.length === 0) {
    return [emptyCustomerOperationContract()]
  }

  const [firstStoreName, ...extraStoreNames] = storeNames
  if (!legacyFirst.shopName && firstStoreName) legacyFirst.shopName = firstStoreName

  return [
    legacyFirst,
    ...extraStoreNames.map((shopName) => ({ ...emptyCustomerOperationContract(), shopName })),
  ].filter(operationContractHasValue)
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
  const basicFields = customerProfileBasicFieldDefinitions.map((definition) => {
    const value = readProfileValue(source, [definition.key, ...definition.aliases])
    return {
      key: definition.key,
      label: definition.label,
      value,
      required: definition.required,
      missing: definition.required && !value,
    }
  })
  const operationContracts = readOperationContracts(source)
  const operationFields = operationContracts.flatMap((contract) => (
    customerOperationContractFieldDefinitions.map((definition) => ({
      key: definition.key,
      label: definition.label,
      value: contract[definition.key],
      required: definition.required,
      missing: definition.required && !contract[definition.key],
    }))
  ))
  const fields = [...basicFields, ...operationFields]
  const requiredFields = basicFields.filter((field) => field.required)
  const missingRequiredFields = requiredFields.filter((field) => field.missing)
  const completedRequiredCount = requiredFields.length - missingRequiredFields.length
  const company = basicFields.find((field) => field.key === 'companyName')?.value ?? ''
  const firstShop = operationContracts.find(operationContractHasValue)?.shopName ?? ''
  const number = basicFields.find((field) => field.key === 'customerNumber')?.value ?? ''
  const contact = basicFields.find((field) => field.key === 'contactName')?.value ?? ''

  return {
    fields,
    basicFields,
    operationContracts,
    requiredFields,
    missingRequiredFields,
    completedRequiredCount,
    totalRequiredCount: requiredFields.length,
    completionLabel: `${completedRequiredCount}/${requiredFields.length}`,
    displayName: number && contact ? `${number}_${contact}` : null,
    primaryLine: [company, firstShop].filter(Boolean).join(' / '),
    secondaryLine: [number, contact].filter(Boolean).join(' / '),
    broadcastExcluded: isCustomerBroadcastExcluded(source),
  }
}

export function customerProfileFormFromMetadata(metadata: Record<string, unknown> | null | undefined): CustomerProfileForm {
  const profile = customerProfileFromMetadata(metadata)
  return {
    basic: Object.fromEntries(
      profile.basicFields.map((field) => [field.key, field.value]),
    ) as Record<CustomerProfileBasicFieldKey, string>,
    operationContracts: profile.operationContracts.length > 0
      ? profile.operationContracts
      : [emptyCustomerOperationContract()],
  }
}

export function customerProfileMetadataPatch(form: CustomerProfileForm): Record<string, unknown> {
  const operationContracts = form.operationContracts
    .map((contract) => Object.fromEntries(
      customerOperationContractFieldDefinitions.map((field) => [field.key, contract[field.key]?.trim() ?? '']),
    ) as CustomerOperationContract)
    .filter(operationContractHasValue)
  const firstContract = operationContracts[0] ?? emptyCustomerOperationContract()

  return {
    customerNumber: form.basic.customerNumber?.trim() ?? '',
    companyName: form.basic.companyName?.trim() ?? '',
    contactName: form.basic.contactName?.trim() ?? '',
    googleFolderUrl: form.basic.googleFolderUrl?.trim() ?? '',
    closingMonth: form.basic.closingMonth?.trim() ?? '',
    specialNotes: form.basic.specialNotes?.trim() ?? '',
    operationContracts,
    // Legacy mirrors keep older filters and displays working while new UI uses operationContracts.
    storeName: firstContract.shopName,
    shopName: firstContract.shopName,
    handoverDate: firstContract.handoverDate,
    minimumGuarantee: firstContract.minimumGuaranteeStartMonth,
    minimumGuaranteeStartMonth: firstContract.minimumGuaranteeStartMonth,
    closedAt: firstContract.closedAt,
  }
}

export function isCustomerProfileMetadataKey(key: string): boolean {
  return profileMetadataKeys.has(key)
}
