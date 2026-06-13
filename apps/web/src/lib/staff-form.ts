export type StaffCreateRole = 'admin' | 'staff'

export type StaffCreateFormInput = {
  name: string
  email: string
  role: StaffCreateRole
}

export type StaffCreatePayload = {
  name: string
  role: StaffCreateRole
  email?: string
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
      role: input.role,
      ...(email ? { email } : {}),
    },
  }
}

export function staffOperationFailureMessage(operation: StaffOperationFailure): string {
  return STAFF_OPERATION_FAILURE_MESSAGES[operation]
}
