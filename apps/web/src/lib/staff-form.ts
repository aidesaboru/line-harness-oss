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
