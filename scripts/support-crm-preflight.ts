#!/usr/bin/env tsx
import { argv, env, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

type Role = 'owner' | 'admin' | 'staff';

type RoleCredential = {
  role: Role;
  apiKey: string;
};

export type SupportCrmPreflightConfig = {
  apiUrl: string;
  adminOrigin?: string;
  lineAccountId: string;
  credentials: RoleCredential[];
  staffVisibleCaseId?: string;
  staffForbiddenCaseId?: string;
  staffNonResolvedCaseId?: string;
  staffResolvedCaseId?: string;
  staffVisibleFriendId?: string;
  staffForbiddenFriendId?: string;
  staffResolvedFriendId?: string;
  checkStaffMutationGuard: boolean;
  requireFullCoverage: boolean;
};

export type CheckStatus = 'pass' | 'fail' | 'skip';

export type CheckResult = {
  status: CheckStatus;
  name: string;
  detail?: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type JsonResponse = {
  status: number;
  json: unknown;
};

export const STAFF_SCOPE_FIXTURE_ENVS = [
  'SUPPORT_CRM_STAFF_VISIBLE_CASE_ID',
  'SUPPORT_CRM_STAFF_FORBIDDEN_CASE_ID',
  'SUPPORT_CRM_STAFF_NON_RESOLVED_CASE_ID',
  'SUPPORT_CRM_STAFF_RESOLVED_CASE_ID',
  'SUPPORT_CRM_STAFF_VISIBLE_FRIEND_ID',
  'SUPPORT_CRM_STAFF_FORBIDDEN_FRIEND_ID',
  'SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID',
] as const;

export const STRICT_PREFLIGHT_DRY_RUN_ENVS = [
  'SUPPORT_CRM_API_URL',
  'SUPPORT_CRM_ADMIN_ORIGIN',
  'SUPPORT_CRM_LINE_ACCOUNT_ID',
  'SUPPORT_CRM_OWNER_API_KEY',
  'SUPPORT_CRM_STAFF_API_KEY',
  'SUPPORT_CRM_REQUIRE_FULL_COVERAGE',
  ...STAFF_SCOPE_FIXTURE_ENVS,
] as const;

export function normalizeApiUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

export function normalizeOrigin(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

export function redactSecret(secret: string): string {
  if (secret.length <= 8) return '********';
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

export function configFromEnv(source: NodeJS.ProcessEnv): { ok: true; config: SupportCrmPreflightConfig } | { ok: false; error: string } {
  const apiUrl = normalizeApiUrl(optional(source.SUPPORT_CRM_API_URL) ?? optional(source.NEXT_PUBLIC_API_URL) ?? '');
  const adminOrigin = optional(source.SUPPORT_CRM_ADMIN_ORIGIN);
  const lineAccountId = optional(source.SUPPORT_CRM_LINE_ACCOUNT_ID);
  const credentials: RoleCredential[] = [];

  const ownerKey = optional(source.SUPPORT_CRM_OWNER_API_KEY) ?? optional(source.SUPPORT_CRM_OWNER_KEY) ?? optional(source.SUPPORT_CRM_API_KEY);
  const adminKey = optional(source.SUPPORT_CRM_ADMIN_API_KEY) ?? optional(source.SUPPORT_CRM_ADMIN_KEY);
  const staffKey = optional(source.SUPPORT_CRM_STAFF_API_KEY) ?? optional(source.SUPPORT_CRM_STAFF_KEY);

  if (ownerKey) credentials.push({ role: 'owner', apiKey: ownerKey });
  if (adminKey) credentials.push({ role: 'admin', apiKey: adminKey });
  if (staffKey) credentials.push({ role: 'staff', apiKey: staffKey });

  const missing: string[] = [];
  if (!apiUrl) missing.push('SUPPORT_CRM_API_URL or NEXT_PUBLIC_API_URL');
  if (!lineAccountId) missing.push('SUPPORT_CRM_LINE_ACCOUNT_ID');
  if (credentials.length === 0) missing.push('at least one SUPPORT_CRM_*_API_KEY');
  if (missing.length > 0) {
    return { ok: false, error: `Missing required env: ${missing.join(', ')}` };
  }

  return {
    ok: true,
    config: {
      apiUrl,
      adminOrigin: adminOrigin ? normalizeOrigin(adminOrigin) : undefined,
      lineAccountId,
      credentials,
      staffVisibleCaseId: optional(source.SUPPORT_CRM_STAFF_VISIBLE_CASE_ID),
      staffForbiddenCaseId: optional(source.SUPPORT_CRM_STAFF_FORBIDDEN_CASE_ID),
      staffNonResolvedCaseId: optional(source.SUPPORT_CRM_STAFF_NON_RESOLVED_CASE_ID),
      staffResolvedCaseId: optional(source.SUPPORT_CRM_STAFF_RESOLVED_CASE_ID),
      staffVisibleFriendId: optional(source.SUPPORT_CRM_STAFF_VISIBLE_FRIEND_ID),
      staffForbiddenFriendId: optional(source.SUPPORT_CRM_STAFF_FORBIDDEN_FRIEND_ID),
      staffResolvedFriendId: optional(source.SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID),
      checkStaffMutationGuard: source.SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD === undefined
        ? true
        : truthy(source.SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD),
      requireFullCoverage: truthy(source.SUPPORT_CRM_REQUIRE_FULL_COVERAGE) || truthy(source.SUPPORT_CRM_STRICT),
    },
  };
}

function result(status: CheckStatus, name: string, detail?: string): CheckResult {
  return detail ? { status, name, detail } : { status, name };
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function requestJson(
  fetchImpl: FetchLike,
  config: SupportCrmPreflightConfig,
  credential: RoleCredential,
  path: string,
  init: RequestInit = {},
): Promise<JsonResponse> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${credential.apiKey}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetchImpl(`${config.apiUrl}${path}`, {
    ...init,
    headers,
  });

  let json: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json };
}

function hasSuccessEnvelope(value: unknown): value is { success: boolean; data?: unknown; error?: string } {
  return typeof value === 'object' && value !== null && 'success' in value;
}

function hasArrayData(value: unknown): boolean {
  return hasSuccessEnvelope(value) && value.success === true && Array.isArray(value.data);
}

function hasObjectData(value: unknown): boolean {
  return hasSuccessEnvelope(value) && value.success === true && typeof value.data === 'object' && value.data !== null;
}

async function expectOkObject(
  fetchImpl: FetchLike,
  config: SupportCrmPreflightConfig,
  credential: RoleCredential,
  name: string,
  path: string,
): Promise<CheckResult> {
  try {
    const res = await requestJson(fetchImpl, config, credential, path);
    if (res.status === 200 && hasObjectData(res.json)) return result('pass', name);
    return result('fail', name, `expected 200 success object, got ${res.status}`);
  } catch (err) {
    return result('fail', name, err instanceof Error ? err.message : 'request failed');
  }
}

async function expectOkArray(
  fetchImpl: FetchLike,
  config: SupportCrmPreflightConfig,
  credential: RoleCredential,
  name: string,
  path: string,
): Promise<CheckResult> {
  try {
    const res = await requestJson(fetchImpl, config, credential, path);
    if (res.status === 200 && hasArrayData(res.json)) return result('pass', name);
    return result('fail', name, `expected 200 success array, got ${res.status}`);
  } catch (err) {
    return result('fail', name, err instanceof Error ? err.message : 'request failed');
  }
}

async function checkRoleIdentity(
  fetchImpl: FetchLike,
  config: SupportCrmPreflightConfig,
  credential: RoleCredential,
): Promise<CheckResult> {
  const name = `${credential.role}: login identity`;
  try {
    const res = await requestJson(fetchImpl, config, credential, '/api/staff/me');
    if (res.status !== 200 || !hasObjectData(res.json)) {
      return result('fail', name, `expected 200 success object, got ${res.status}`);
    }
    const data = res.json.data as { role?: unknown; name?: unknown };
    if (data.role !== credential.role) {
      return result('fail', name, `expected role ${credential.role}, got ${String(data.role)}`);
    }
    if (credential.role === 'staff' && (typeof data.name !== 'string' || !data.name.trim())) {
      return result('fail', name, 'staff name is required for support visibility checks');
    }
    return result('pass', name, `key ${redactSecret(credential.apiKey)}`);
  } catch (err) {
    return result('fail', name, err instanceof Error ? err.message : 'request failed');
  }
}

async function checkExpectedStatus(
  fetchImpl: FetchLike,
  config: SupportCrmPreflightConfig,
  credential: RoleCredential,
  name: string,
  path: string,
  allowedStatuses: number[],
  init: RequestInit = {},
): Promise<CheckResult> {
  try {
    const res = await requestJson(fetchImpl, config, credential, path, init);
    if (allowedStatuses.includes(res.status)) return result('pass', name, `got ${res.status}`);
    return result('fail', name, `expected ${allowedStatuses.join('/')}, got ${res.status}`);
  } catch (err) {
    return result('fail', name, err instanceof Error ? err.message : 'request failed');
  }
}

function skipIfMissing(name: string, envName: string): CheckResult {
  return result('skip', name, `${envName} is not set`);
}

function requiredEnvResult(name: string, envName: string, value: string | undefined, required: boolean): CheckResult {
  if (value) return result('pass', name, 'set');
  return result(required ? 'fail' : 'skip', name, `${envName} is not set`);
}

function credentialSummary(credentials: RoleCredential[]): string {
  return credentials.map((credential) => `${credential.role}=${redactSecret(credential.apiKey)}`).join(', ');
}

async function checkCredentialedPreflight(
  fetchImpl: FetchLike,
  config: SupportCrmPreflightConfig,
): Promise<CheckResult> {
  const name = 'admin login CORS preflight';
  if (!config.adminOrigin) return skipIfMissing(name, 'SUPPORT_CRM_ADMIN_ORIGIN');

  try {
    const res = await fetchImpl(`${config.apiUrl}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: config.adminOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    const allowOrigin = res.headers.get('Access-Control-Allow-Origin');
    const allowCredentials = res.headers.get('Access-Control-Allow-Credentials');
    const allowHeaders = res.headers.get('Access-Control-Allow-Headers') ?? '';

    if (!res.ok) return result('fail', name, `expected 2xx, got ${res.status}`);
    if (allowOrigin !== config.adminOrigin) {
      return result('fail', name, `expected Access-Control-Allow-Origin ${config.adminOrigin}, got ${allowOrigin ?? 'missing'}`);
    }
    if (allowCredentials !== 'true') {
      return result('fail', name, `expected Access-Control-Allow-Credentials true, got ${allowCredentials ?? 'missing'}`);
    }
    if (!allowHeaders.toLowerCase().split(',').map((item) => item.trim()).includes('content-type')) {
      return result('fail', name, `expected Access-Control-Allow-Headers to include content-type, got ${allowHeaders || 'missing'}`);
    }
    return result('pass', name, config.adminOrigin);
  } catch (err) {
    return result('fail', name, err instanceof Error ? err.message : 'request failed');
  }
}

async function runRoleChecks(
  fetchImpl: FetchLike,
  config: SupportCrmPreflightConfig,
  credential: RoleCredential,
): Promise<CheckResult[]> {
  const lineAccountQuery = query({ lineAccountId: config.lineAccountId });
  const checks: CheckResult[] = [];
  checks.push(await checkRoleIdentity(fetchImpl, config, credential));
  checks.push(await expectOkObject(fetchImpl, config, credential, `${credential.role}: capabilities`, '/api/capabilities'));
  checks.push(await expectOkObject(fetchImpl, config, credential, `${credential.role}: support summary`, `/api/support/summary?${lineAccountQuery}`));
  checks.push(await expectOkArray(fetchImpl, config, credential, `${credential.role}: support cases`, `/api/support/cases?${query({ lineAccountId: config.lineAccountId, queue: 'unresolved', limit: '5' })}`));
  checks.push(await expectOkArray(fetchImpl, config, credential, `${credential.role}: support manuals`, `/api/support/manuals?${query({ lineAccountId: config.lineAccountId, active: '1' })}`));
  checks.push(await expectOkArray(fetchImpl, config, credential, `${credential.role}: chats`, `/api/chats?${lineAccountQuery}`));

  if (credential.role !== 'staff') return checks;

  if (config.checkStaffMutationGuard) {
    checks.push(await checkExpectedStatus(
      fetchImpl,
      config,
      credential,
      'staff: case creation is blocked',
      '/api/support/cases',
      [403],
      {
        method: 'POST',
        body: JSON.stringify({
          lineAccountId: config.lineAccountId,
          title: 'preflight case creation guard',
        }),
      },
    ));
    checks.push(await checkExpectedStatus(
      fetchImpl,
      config,
      credential,
      'staff: manual creation is blocked',
      '/api/support/manuals',
      [403],
      {
        method: 'POST',
        body: JSON.stringify({
          lineAccountId: config.lineAccountId,
          title: '',
          body: '',
        }),
      },
    ));
    const impossibleManualId = 'preflight-manual-mutation-guard-never-exists';
    checks.push(await checkExpectedStatus(
      fetchImpl,
      config,
      credential,
      'staff: manual update is blocked',
      `/api/support/manuals/${encodeURIComponent(impossibleManualId)}`,
      [403],
      {
        method: 'PATCH',
        body: JSON.stringify({
          lineAccountId: config.lineAccountId,
          title: '',
        }),
      },
    ));
    checks.push(await checkExpectedStatus(
      fetchImpl,
      config,
      credential,
      'staff: manual archive is blocked',
      `/api/support/manuals/${encodeURIComponent(impossibleManualId)}?${lineAccountQuery}`,
      [403],
      { method: 'DELETE' },
    ));
    if (config.staffVisibleCaseId) {
      checks.push(await checkExpectedStatus(
        fetchImpl,
        config,
        credential,
        'staff: routing mutation is blocked',
        `/api/support/cases/${encodeURIComponent(config.staffVisibleCaseId)}`,
        [403],
        {
          method: 'PATCH',
          body: JSON.stringify({
            lineAccountId: config.lineAccountId,
            primaryAssignee: 'preflight forbidden assignee',
            priority: '__preflight_invalid_priority__',
          }),
        },
      ));
      checks.push(await checkExpectedStatus(
        fetchImpl,
        config,
        credential,
        'staff: escalation routing creation is blocked',
        `/api/support/cases/${encodeURIComponent(config.staffVisibleCaseId)}/escalations`,
        [403],
        {
          method: 'POST',
          body: JSON.stringify({
            lineAccountId: config.lineAccountId,
            assignee: 'preflight forbidden escalation assignee',
            level: 'L3',
            dueAt: '2099-01-01T18:00',
            question: '',
          }),
        },
      ));
    } else {
      checks.push(skipIfMissing('staff: routing mutation is blocked', 'SUPPORT_CRM_STAFF_VISIBLE_CASE_ID'));
      checks.push(skipIfMissing('staff: escalation routing creation is blocked', 'SUPPORT_CRM_STAFF_VISIBLE_CASE_ID'));
    }

    if (config.staffNonResolvedCaseId) {
      checks.push(await checkExpectedStatus(
        fetchImpl,
        config,
        credential,
        'staff: non-resolved case cannot be reopened',
        `/api/support/cases/${encodeURIComponent(config.staffNonResolvedCaseId)}`,
        [400],
        {
          method: 'PATCH',
          body: JSON.stringify({
            lineAccountId: config.lineAccountId,
            status: 'reopened',
          }),
        },
      ));
    } else {
      checks.push(skipIfMissing('staff: non-resolved case cannot be reopened', 'SUPPORT_CRM_STAFF_NON_RESOLVED_CASE_ID'));
    }

    if (config.staffResolvedCaseId && config.staffResolvedFriendId) {
      checks.push(await checkExpectedStatus(
        fetchImpl,
        config,
        credential,
        'staff: resolved support reply send is blocked',
        `/api/chats/${encodeURIComponent(config.staffResolvedFriendId)}/send/validate`,
        [400],
        {
          method: 'POST',
          body: JSON.stringify({
            content: 'preflight resolved support reply guard',
            supportCaseId: config.staffResolvedCaseId,
            lineAccountId: config.lineAccountId,
          }),
        },
      ));
    } else if (config.staffResolvedCaseId || config.staffResolvedFriendId) {
      checks.push(result(
        'skip',
        'staff: resolved support reply send is blocked',
        'both SUPPORT_CRM_STAFF_RESOLVED_CASE_ID and SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID are required',
      ));
    } else {
      checks.push(skipIfMissing('staff: resolved support reply send is blocked', 'SUPPORT_CRM_STAFF_RESOLVED_CASE_ID/SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID'));
    }
  }

  if (config.staffVisibleCaseId) {
    checks.push(await checkExpectedStatus(
      fetchImpl,
      config,
      credential,
      'staff: visible case can be opened',
      `/api/support/cases/${encodeURIComponent(config.staffVisibleCaseId)}?${lineAccountQuery}`,
      [200],
    ));
  } else {
    checks.push(skipIfMissing('staff: visible case can be opened', 'SUPPORT_CRM_STAFF_VISIBLE_CASE_ID'));
  }

  if (config.staffForbiddenCaseId) {
    checks.push(await checkExpectedStatus(
      fetchImpl,
      config,
      credential,
      'staff: forbidden case is hidden',
      `/api/support/cases/${encodeURIComponent(config.staffForbiddenCaseId)}?${lineAccountQuery}`,
      [403, 404],
    ));
  } else {
    checks.push(skipIfMissing('staff: forbidden case is hidden', 'SUPPORT_CRM_STAFF_FORBIDDEN_CASE_ID'));
  }

  if (config.staffVisibleFriendId) {
    checks.push(await checkExpectedStatus(
      fetchImpl,
      config,
      credential,
      'staff: visible chat can be opened',
      `/api/chats/${encodeURIComponent(config.staffVisibleFriendId)}`,
      [200],
    ));
    checks.push(await checkExpectedStatus(
      fetchImpl,
      config,
      credential,
      'staff: unsupported chat message type is blocked',
      `/api/chats/${encodeURIComponent(config.staffVisibleFriendId)}/send/validate`,
      [400],
      {
        method: 'POST',
        body: JSON.stringify({
          messageType: 'sticker',
          content: JSON.stringify({ packageId: '1', stickerId: '1' }),
        }),
      },
    ));
  } else {
    checks.push(skipIfMissing('staff: visible chat can be opened', 'SUPPORT_CRM_STAFF_VISIBLE_FRIEND_ID'));
    checks.push(skipIfMissing('staff: unsupported chat message type is blocked', 'SUPPORT_CRM_STAFF_VISIBLE_FRIEND_ID'));
  }

  if (config.staffForbiddenFriendId) {
    checks.push(await checkExpectedStatus(
      fetchImpl,
      config,
      credential,
      'staff: forbidden chat is hidden',
      `/api/chats/${encodeURIComponent(config.staffForbiddenFriendId)}`,
      [403, 404],
    ));
  } else {
    checks.push(skipIfMissing('staff: forbidden chat is hidden', 'SUPPORT_CRM_STAFF_FORBIDDEN_FRIEND_ID'));
  }

  return checks;
}

export async function runSupportCrmPreflight(
  config: SupportCrmPreflightConfig,
  fetchImpl: FetchLike = fetch,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  if (config.requireFullCoverage) {
    const roles = new Set(config.credentials.map((credential) => credential.role));
    if (!roles.has('owner') && !roles.has('admin')) {
      results.push(result('fail', 'preflight: owner/admin credential required', 'SUPPORT_CRM_OWNER_API_KEY or SUPPORT_CRM_ADMIN_API_KEY is required when SUPPORT_CRM_REQUIRE_FULL_COVERAGE=1'));
    }
    if (!roles.has('staff')) {
      results.push(result('fail', 'preflight: staff credential required', 'SUPPORT_CRM_STAFF_API_KEY is required when SUPPORT_CRM_REQUIRE_FULL_COVERAGE=1'));
    }
    if (!config.checkStaffMutationGuard) {
      results.push(result('fail', 'preflight: staff mutation guard required', 'SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD must stay enabled when SUPPORT_CRM_REQUIRE_FULL_COVERAGE=1'));
    }
  }
  results.push(await checkCredentialedPreflight(fetchImpl, config));
  for (const credential of config.credentials) {
    results.push(...await runRoleChecks(fetchImpl, config, credential));
  }
  if (config.requireFullCoverage) {
    const skipped = results.filter((item) => item.status === 'skip');
    if (skipped.length > 0) {
      results.push(result(
        'fail',
        'preflight: full coverage required',
        `${skipped.length} optional checks skipped`,
      ));
    }
  }
  return results;
}

export function buildPreflightDryRunResults(source: NodeJS.ProcessEnv): CheckResult[] {
  const apiUrl = normalizeApiUrl(optional(source.SUPPORT_CRM_API_URL) ?? optional(source.NEXT_PUBLIC_API_URL) ?? '');
  const adminOrigin = optional(source.SUPPORT_CRM_ADMIN_ORIGIN);
  const lineAccountId = optional(source.SUPPORT_CRM_LINE_ACCOUNT_ID);
  const requireFullCoverage = truthy(source.SUPPORT_CRM_REQUIRE_FULL_COVERAGE) || truthy(source.SUPPORT_CRM_STRICT);
  const fullCoverageDetail = truthy(source.SUPPORT_CRM_REQUIRE_FULL_COVERAGE)
    ? 'SUPPORT_CRM_REQUIRE_FULL_COVERAGE=1'
    : truthy(source.SUPPORT_CRM_STRICT)
      ? 'SUPPORT_CRM_STRICT=1'
      : 'SUPPORT_CRM_REQUIRE_FULL_COVERAGE is not set';
  const checkStaffMutationGuard = source.SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD === undefined
    ? true
    : truthy(source.SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD);

  const credentials: RoleCredential[] = [];
  const ownerKey = optional(source.SUPPORT_CRM_OWNER_API_KEY) ?? optional(source.SUPPORT_CRM_OWNER_KEY) ?? optional(source.SUPPORT_CRM_API_KEY);
  const adminKey = optional(source.SUPPORT_CRM_ADMIN_API_KEY) ?? optional(source.SUPPORT_CRM_ADMIN_KEY);
  const staffKey = optional(source.SUPPORT_CRM_STAFF_API_KEY) ?? optional(source.SUPPORT_CRM_STAFF_KEY);
  if (ownerKey) credentials.push({ role: 'owner', apiKey: ownerKey });
  if (adminKey) credentials.push({ role: 'admin', apiKey: adminKey });
  if (staffKey) credentials.push({ role: 'staff', apiKey: staffKey });

  const results: CheckResult[] = [
    requiredEnvResult('env: API URL', 'SUPPORT_CRM_API_URL or NEXT_PUBLIC_API_URL', apiUrl, true),
    requiredEnvResult('env: LINE account ID', 'SUPPORT_CRM_LINE_ACCOUNT_ID', lineAccountId, true),
    requiredEnvResult('env: admin origin', 'SUPPORT_CRM_ADMIN_ORIGIN', adminOrigin ? normalizeOrigin(adminOrigin) : undefined, requireFullCoverage),
  ];

  if (credentials.length > 0) {
    results.push(result('pass', 'env: API credentials', credentialSummary(credentials)));
  } else {
    results.push(result('fail', 'env: API credentials', 'at least one SUPPORT_CRM_*_API_KEY is required'));
  }

  const hasOwnerAdmin = Boolean(ownerKey || adminKey);
  const hasStaff = Boolean(staffKey);
  results.push(result(hasOwnerAdmin ? 'pass' : requireFullCoverage ? 'fail' : 'skip', 'env: owner/admin API key', hasOwnerAdmin ? 'set' : 'SUPPORT_CRM_OWNER_API_KEY or SUPPORT_CRM_ADMIN_API_KEY is not set'));
  results.push(result(hasStaff ? 'pass' : requireFullCoverage ? 'fail' : 'skip', 'env: staff API key', hasStaff ? redactSecret(staffKey ?? '') : 'SUPPORT_CRM_STAFF_API_KEY is not set'));
  results.push(result(requireFullCoverage ? 'pass' : 'skip', 'env: full coverage mode', fullCoverageDetail));
  results.push(result(checkStaffMutationGuard ? 'pass' : requireFullCoverage ? 'fail' : 'skip', 'env: staff mutation guard', checkStaffMutationGuard ? 'enabled' : 'SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD=0'));

  for (const envName of STAFF_SCOPE_FIXTURE_ENVS) {
    results.push(requiredEnvResult(`env: ${envName}`, envName, optional(source[envName]), requireFullCoverage));
  }

  return results;
}

export function nextActionForResult(item: CheckResult): string | null {
  if (item.status === 'pass') return null;
  const name = item.name.toLowerCase();
  const detail = (item.detail ?? '').toLowerCase();

  if (item.status === 'skip') {
    if (name.includes('admin login cors')) {
      return 'Set SUPPORT_CRM_ADMIN_ORIGIN to verify browser login CORS with credentials.';
    }
    if (detail.includes('both support_crm_staff_resolved_case_id and support_crm_staff_resolved_friend_id')) {
      return 'Set both SUPPORT_CRM_STAFF_RESOLVED_CASE_ID and SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID to verify the resolved-case reply guard.';
    }
    if (detail.includes('support_crm_staff_resolved_case_id/support_crm_staff_resolved_friend_id')) {
      return 'Set resolved case and friend fixture IDs to verify that completed cases cannot send support replies.';
    }
    if (detail.includes('support_crm_staff_')) {
      return `Set ${item.detail?.replace(' is not set', '')} to enable this optional staff-scope check.`;
    }
    return 'Set the optional fixture env mentioned above when you need this coverage.';
  }

  if (name.includes('login identity')) {
    if (detail.includes('expected role')) {
      return 'Use an API key that actually belongs to the declared SUPPORT_CRM_*_API_KEY role.';
    }
    if (detail.includes('staff name')) {
      return 'Open staff management and set a non-blank staff name; staff visibility checks match by staff name.';
    }
    return 'Check that the API key is active and /api/staff/me returns the expected role and name.';
  }
  if (name.includes('full coverage required')) {
    return 'Set the fixture/env values listed under Skipped optional checks, or unset SUPPORT_CRM_REQUIRE_FULL_COVERAGE when partial coverage is intentional.';
  }
  if (name.includes('credential required') || name.startsWith('env: owner/admin api key') || name.startsWith('env: staff api key')) {
    return 'Set both an owner/admin API key and a staff API key before strict production cutover.';
  }
  if (name.includes('staff mutation guard required') || name.startsWith('env: staff mutation guard')) {
    return 'Keep SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD enabled during strict production cutover.';
  }
  if (name.startsWith('env:')) {
    return 'Set the missing environment variable shown in the detail, then rerun the dry-run.';
  }
  if (name.includes('admin login cors')) {
    return 'Check SUPPORT_CRM_ADMIN_ORIGIN and the Worker CORS settings for credentialed browser login.';
  }
  if (name.includes('capabilities')) {
    return 'Check authentication middleware and /api/capabilities for this API key.';
  }
  if (name.includes('support summary') || name.includes('support cases') || name.includes('support manuals') || name.endsWith(': chats')) {
    return 'Check SUPPORT_CRM_LINE_ACCOUNT_ID, the API key role, and the corresponding support/chats endpoint.';
  }
  if (name.includes('is blocked')) {
    return 'Check staff role guards; staff must not be able to mutate routing, manual, or owner/admin-only resources.';
  }
  if (name.includes('cannot be reopened')) {
    return 'Check support case status transition rules; only resolved cases should move to reopened.';
  }
  if (name.includes('resolved support reply send')) {
    return 'Check /api/chats/:id/send/validate and send guards; resolved support cases must stop before LINE push.';
  }
  if (name.includes('visible') || name.includes('forbidden')) {
    return 'Check staff fixture IDs and support visibility rules for cases/chats.';
  }
  return 'Inspect the endpoint, API key, and fixture env shown by this check.';
}

export function formatResults(results: CheckResult[]): string {
  const lines: string[] = [];
  for (const item of results) {
    const prefix = item.status === 'pass' ? 'PASS' : item.status === 'skip' ? 'SKIP' : 'FAIL';
    const detail = item.detail ? ` - ${item.detail}` : '';
    lines.push(`${prefix} ${item.name}${detail}`);
  }

  const passed = results.filter((item) => item.status === 'pass').length;
  const skipped = results.filter((item) => item.status === 'skip').length;
  const failed = results.filter((item) => item.status === 'fail').length;
  lines.push('', `Support CRM preflight: ${passed} passed, ${skipped} skipped, ${failed} failed.`);

  const failures = results.filter((item) => item.status === 'fail');
  if (failures.length > 0) {
    lines.push('', 'Failures to fix:');
    failures.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.name}${item.detail ? ` - ${item.detail}` : ''}`);
      const action = nextActionForResult(item);
      if (action) lines.push(`   Next: ${action}`);
    });
  }

  const skippedChecks = results.filter((item) => item.status === 'skip');
  if (skippedChecks.length > 0) {
    lines.push('', 'Skipped optional checks:');
    skippedChecks.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.name}${item.detail ? ` - ${item.detail}` : ''}`);
      const action = nextActionForResult(item);
      if (action) lines.push(`   Enable: ${action}`);
    });
  }

  return `${lines.join('\n')}\n`;
}

export function formatDryRunResults(results: CheckResult[]): string {
  return [
    'Support CRM preflight dry-run (no network requests).',
    'Secrets are redacted; this only checks whether the release env is shaped correctly.',
    '',
    formatResults(results).trimEnd(),
    '',
  ].join('\n');
}

function printResults(results: CheckResult[]): void {
  stdout.write(formatResults(results));
}

function usage(): string {
  return [
    'Support CRM preflight checks.',
    '',
    'Required env:',
    '  SUPPORT_CRM_API_URL or NEXT_PUBLIC_API_URL',
    '  SUPPORT_CRM_LINE_ACCOUNT_ID',
    '  SUPPORT_CRM_OWNER_API_KEY and/or SUPPORT_CRM_ADMIN_API_KEY and/or SUPPORT_CRM_STAFF_API_KEY',
    '',
    'Optional browser-login CORS env:',
    '  SUPPORT_CRM_ADMIN_ORIGIN',
    '',
    'Optional staff-scope fixture env:',
    '  SUPPORT_CRM_STAFF_VISIBLE_CASE_ID',
    '  SUPPORT_CRM_STAFF_FORBIDDEN_CASE_ID',
    '  SUPPORT_CRM_STAFF_NON_RESOLVED_CASE_ID',
    '  SUPPORT_CRM_STAFF_RESOLVED_CASE_ID',
    '  SUPPORT_CRM_STAFF_VISIBLE_FRIEND_ID',
    '  SUPPORT_CRM_STAFF_FORBIDDEN_FRIEND_ID',
    '  SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID',
    '  SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD=0 to skip the staff 403 mutation guard',
    '  SUPPORT_CRM_REQUIRE_FULL_COVERAGE=1 to fail when optional checks are skipped',
    '',
    'Modes:',
    '  --dry-run  validate required env shape without network requests',
  ].join('\n');
}

const isCliEntry = (() => {
  if (!argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === argv[1];
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(`${usage()}\n`);
    exit(0);
  }

  if (argv.includes('--dry-run')) {
    const results = buildPreflightDryRunResults(env);
    stdout.write(formatDryRunResults(results));
    exit(results.some((item) => item.status === 'fail') ? 1 : 0);
  }

  const parsed = configFromEnv(env);
  if (!parsed.ok) {
    stderr.write(`${parsed.error}\n\n${usage()}\n`);
    exit(2);
  }

  runSupportCrmPreflight(parsed.config)
    .then((results) => {
      printResults(results);
      exit(results.some((item) => item.status === 'fail') ? 1 : 0);
    })
    .catch((err) => {
      stderr.write(`support-crm-preflight: ${(err as Error).message}\n`);
      exit(1);
    });
}
