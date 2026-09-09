export type StaffCreateRole = 'admin' | 'staff' | 'secondary'
export type StaffAccessSelection = 'admin' | 'staff' | 'sales_viewer' | 'secondary_viewer' | 'secondary_responder'

export type StaffCreateFormInput = {
  name: string
  email: string
  role: StaffAccessSelection
}

export type StaffCreatePayload = {
  name: string
  role: StaffCreateRole
  email?: string
  secondaryCanRespond?: boolean
  salesOnly?: boolean
}

export type StaffCreateValidationResult =
  | { ok: true; payload: StaffCreatePayload }
  | { ok: false; error: string }

export type StaffOperationFailure =
  | 'load'
  | 'create'
  | 'update'
  | 'regenerate-key'
  | 'delete'

const STAFF_OPERATION_FAILURE_MESSAGES: Record<StaffOperationFailure, string> = {
  load: 'スタッフの読み込みに失敗しました。もう一度お試しください。',
  create: 'スタッフの作成に失敗しました。入力内容を確認して、もう一度お試しください。',
  update: 'スタッフ情報の更新に失敗しました。もう一度お試しください。',
  'regenerate-key': 'APIキーの再生成に失敗しました。もう一度お試しください。',
  delete: 'スタッフの削除に失敗しました。もう一度お試しください。',
}

export function buildStaffCreatePayload(input: StaffCreateFormInput): StaffCreateValidationResult {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'スタッフ名を入力してください' }

  const email = input.email.trim()
  return {
    ok: true,
    payload: {
      name,
      ...staffAccessUpdatePayload(input.role),
      ...(email ? { email } : {}),
    },
  }
}

export function staffAccessSelection(
  role: StaffCreateRole | 'owner',
  secondaryCanRespond: boolean,
  salesOnly = false,
): StaffAccessSelection | 'owner' {
  if (role === 'staff' && salesOnly) return 'sales_viewer'
  if (role === 'secondary') {
    return secondaryCanRespond ? 'secondary_responder' : 'secondary_viewer'
  }
  return role
}

export function staffAccessUpdatePayload(selection: StaffAccessSelection): {
  role: StaffCreateRole
  secondaryCanRespond: boolean
  salesOnly: boolean
} {
  if (selection === 'sales_viewer') {
    return { role: 'staff', secondaryCanRespond: false, salesOnly: true }
  }
  if (selection === 'secondary_viewer') {
    return { role: 'secondary', secondaryCanRespond: false, salesOnly: false }
  }
  if (selection === 'secondary_responder') {
    return { role: 'secondary', secondaryCanRespond: true, salesOnly: false }
  }
  return { role: selection, secondaryCanRespond: false, salesOnly: false }
}

export function staffOperationFailureMessage(operation: StaffOperationFailure): string {
  return STAFF_OPERATION_FAILURE_MESSAGES[operation]
}
