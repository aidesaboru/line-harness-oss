import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPreflightDryRunResults,
  configFromEnv,
  formatDryRunResults,
  formatResults,
  nextActionForResult,
  normalizeApiUrl,
  normalizeOrigin,
  redactSecret,
  runSupportCrmPreflight,
  STRICT_PREFLIGHT_DRY_RUN_ENVS,
  type CheckResult,
  type SupportCrmPreflightConfig,
} from './support-crm-preflight';

type FetchCall = {
  url: URL;
  method: string;
  origin: string | null;
  authorization: string | null;
  contentType: string | null;
  body?: BodyInit | null;
};

function jsonResponse(status: number, body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function successObject(data: unknown): Response {
  return jsonResponse(200, { success: true, data });
}

function successArray(data: unknown[] = []): Response {
  return jsonResponse(200, { success: true, data });
}

function buildConfig(overrides: Partial<SupportCrmPreflightConfig> = {}): SupportCrmPreflightConfig {
  return {
    apiUrl: 'https://worker.example',
    lineAccountId: 'line-1',
    credentials: [
      { role: 'owner', apiKey: 'owner-key' },
      { role: 'staff', apiKey: 'staff-key' },
    ],
    staffVisibleCaseId: 'case-visible',
    staffForbiddenCaseId: 'case-forbidden',
    staffNonResolvedCaseId: 'case-nonresolved',
    staffResolvedCaseId: 'case-resolved',
    staffVisibleFriendId: 'friend-visible',
    staffForbiddenFriendId: 'friend-forbidden',
    staffResolvedFriendId: 'friend-resolved',
    checkStaffMutationGuard: true,
    requireFullCoverage: false,
    ...overrides,
  };
}

function createHappyFetch(calls: FetchCall[] = []): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const authorization = headers.get('Authorization');
    const method = init.method ?? 'GET';
    const role = authorization === 'Bearer owner-key'
      ? 'owner'
      : authorization === 'Bearer admin-key'
        ? 'admin'
        : authorization === 'Bearer staff-key'
          ? 'staff'
          : undefined;

    calls.push({
      url,
      method,
      origin: headers.get('Origin'),
      authorization,
      contentType: headers.get('Content-Type'),
      body: init.body,
    });

    if (!role) return jsonResponse(401, { success: false, error: 'unauthorized' });
    if (url.pathname === '/api/staff/me') {
      return successObject({ role, name: role === 'staff' ? '田島' : 'Owner' });
    }
    if (url.pathname === '/api/capabilities') return successObject({ role });
    if (url.pathname === '/api/support/summary') return successObject({ open: 0 });
    if (url.pathname === '/api/support/cases' && method === 'POST' && role === 'staff') {
      return jsonResponse(403, { success: false, error: 'owner/admin only' });
    }
    if (url.pathname === '/api/support/cases') return successArray();
    if (url.pathname === '/api/support/manuals' && method === 'GET') return successArray();
    if (url.pathname === '/api/chats') return successArray();
    if (url.pathname === '/api/support/manuals' && method === 'POST' && role === 'staff') {
      return jsonResponse(403, { success: false, error: 'owner/admin only' });
    }
    if (url.pathname === '/api/support/manuals/preflight-manual-mutation-guard-never-exists' && (method === 'PATCH' || method === 'DELETE') && role === 'staff') {
      return jsonResponse(403, { success: false, error: 'owner/admin only' });
    }
    if (url.pathname === '/api/support/cases/case-visible' && method === 'PATCH' && role === 'staff') {
      return jsonResponse(403, { success: false, error: 'staff cannot change routing fields' });
    }
    if (url.pathname === '/api/support/cases/case-nonresolved' && method === 'PATCH' && role === 'staff') {
      return jsonResponse(400, { success: false, error: 'only resolved cases can be reopened' });
    }
    if (url.pathname === '/api/chats/friend-resolved/send/validate' && method === 'POST' && role === 'staff') {
      return jsonResponse(400, { success: false, error: 'reopen resolved cases before sending support replies' });
    }
    if (url.pathname === '/api/chats/friend-visible/send/validate' && method === 'POST' && role === 'staff') {
      return jsonResponse(400, { success: false, error: 'messageType must be text, flex, or image' });
    }
    if (url.pathname === '/api/support/cases/case-visible/escalations' && method === 'POST' && role === 'staff') {
      return jsonResponse(403, { success: false, error: 'staff cannot create routed escalations' });
    }
    if (url.pathname === '/api/support/cases/case-visible') return successObject({ id: 'case-visible' });
    if (url.pathname === '/api/support/cases/case-forbidden') return jsonResponse(404, { success: false, error: 'not found' });
    if (url.pathname === '/api/chats/friend-visible') return successObject({ id: 'friend-visible' });
    if (url.pathname === '/api/chats/friend-forbidden') return jsonResponse(404, { success: false, error: 'not found' });
    if (url.pathname === '/api/friends/friend-visible/messages') return successArray([{ id: 'msg-visible' }]);
    if (url.pathname === '/api/friends/friend-forbidden/messages') return jsonResponse(404, { success: false, error: 'not found' });
    if (url.pathname === '/api/friends/friend-visible/score') return successObject({ friendId: 'friend-visible', currentScore: 10, history: [] });
    if (url.pathname === '/api/friends/friend-forbidden/score') return jsonResponse(404, { success: false, error: 'not found' });
    if (url.pathname === '/api/friends/friend-visible/reminders') return successArray([]);
    if (url.pathname === '/api/friends/friend-forbidden/reminders') return jsonResponse(404, { success: false, error: 'not found' });

    return jsonResponse(500, { success: false, error: `unexpected ${method} ${url.pathname}` });
  };
}

function failed(results: CheckResult[]): CheckResult[] {
  return results.filter((item) => item.status === 'fail');
}

describe('support CRM preflight helpers', () => {
  it('keeps the release checklist aligned with strict dry-run env requirements', () => {
    const checklist = readFileSync(
      new URL('../docs/manual/ec-owner-support-crm-release-checklist.md', import.meta.url),
      'utf8',
    );

    expect(checklist).toContain('corepack pnpm preflight:support-crm:dry-run');
    for (const envName of STRICT_PREFLIGHT_DRY_RUN_ENVS) {
      expect(checklist).toContain(envName);
    }
    expect(checklist).toContain('SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD=0');
  });

  it('normalizes API URLs without removing the protocol separator', () => {
    expect(normalizeApiUrl(' https://worker.example/// ')).toBe('https://worker.example');
    expect(normalizeApiUrl('   ')).toBe('');
  });

  it('normalizes admin origins to the browser Origin form', () => {
    expect(normalizeOrigin(' https://admin.example/path?q=1 ')).toBe('https://admin.example');
    expect(normalizeOrigin(' http://127.0.0.1:3001/ ')).toBe('http://127.0.0.1:3001');
  });

  it('redacts API keys for output', () => {
    expect(redactSecret('short')).toBe('********');
    expect(redactSecret('sk_test_1234567890')).toBe('sk_t...7890');
  });

  it('builds config from env and trims optional values', () => {
    const parsed = configFromEnv({
      NEXT_PUBLIC_API_URL: ' https://worker.example/ ',
      SUPPORT_CRM_LINE_ACCOUNT_ID: ' line-1 ',
      SUPPORT_CRM_OWNER_API_KEY: ' owner-key ',
      SUPPORT_CRM_STAFF_API_KEY: ' staff-key ',
      SUPPORT_CRM_STAFF_VISIBLE_CASE_ID: ' case-visible ',
      SUPPORT_CRM_STAFF_NON_RESOLVED_CASE_ID: ' case-nonresolved ',
      SUPPORT_CRM_STAFF_RESOLVED_CASE_ID: ' case-resolved ',
      SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID: ' friend-resolved ',
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.apiUrl).toBe('https://worker.example');
    expect(parsed.config.adminOrigin).toBeUndefined();
    expect(parsed.config.lineAccountId).toBe('line-1');
    expect(parsed.config.credentials).toEqual([
      { role: 'owner', apiKey: 'owner-key' },
      { role: 'staff', apiKey: 'staff-key' },
    ]);
    expect(parsed.config.staffVisibleCaseId).toBe('case-visible');
    expect(parsed.config.staffNonResolvedCaseId).toBe('case-nonresolved');
    expect(parsed.config.staffResolvedCaseId).toBe('case-resolved');
    expect(parsed.config.staffResolvedFriendId).toBe('friend-resolved');
    expect(parsed.config.checkStaffMutationGuard).toBe(true);
  });

  it('reads the optional admin origin for browser-login CORS checks', () => {
    const parsed = configFromEnv({
      SUPPORT_CRM_API_URL: 'https://worker.example',
      SUPPORT_CRM_ADMIN_ORIGIN: ' https://admin.example/path ',
      SUPPORT_CRM_LINE_ACCOUNT_ID: 'line-1',
      SUPPORT_CRM_OWNER_API_KEY: 'owner-key',
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.adminOrigin).toBe('https://admin.example');
  });

  it('reports all missing required env values together', () => {
    const parsed = configFromEnv({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('SUPPORT_CRM_API_URL or NEXT_PUBLIC_API_URL');
    expect(parsed.error).toContain('SUPPORT_CRM_LINE_ACCOUNT_ID');
    expect(parsed.error).toContain('at least one SUPPORT_CRM_*_API_KEY');
  });

  it('allows the staff mutation guard to be disabled explicitly', () => {
    const parsed = configFromEnv({
      SUPPORT_CRM_API_URL: 'https://worker.example',
      SUPPORT_CRM_LINE_ACCOUNT_ID: 'line-1',
      SUPPORT_CRM_STAFF_API_KEY: 'staff-key',
      SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD: '0',
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.checkStaffMutationGuard).toBe(false);
  });

  it('reads strict full-coverage mode from env', () => {
    const parsed = configFromEnv({
      SUPPORT_CRM_API_URL: 'https://worker.example',
      SUPPORT_CRM_LINE_ACCOUNT_ID: 'line-1',
      SUPPORT_CRM_STAFF_API_KEY: 'staff-key',
      SUPPORT_CRM_REQUIRE_FULL_COVERAGE: '1',
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.requireFullCoverage).toBe(true);
  });

  it('formats results with actionable failure and skip guidance', () => {
    const output = formatResults([
      { status: 'pass', name: 'owner: support cases' },
      {
        status: 'fail',
        name: 'staff: login identity',
        detail: 'expected role staff, got owner',
      },
      {
        status: 'skip',
        name: 'staff: visible case can be opened',
        detail: 'SUPPORT_CRM_STAFF_VISIBLE_CASE_ID is not set',
      },
    ]);

    expect(output).toContain('PASS owner: support cases');
    expect(output).toContain('FAIL staff: login identity - expected role staff, got owner');
    expect(output).toContain('Support CRM preflight: 1 passed, 1 skipped, 1 failed.');
    expect(output).toContain('Failures to fix:');
    expect(output).toContain('Next: Use an API key that actually belongs to the declared SUPPORT_CRM_*_API_KEY role.');
    expect(output).toContain('Skipped optional checks:');
    expect(output).toContain('Enable: Set SUPPORT_CRM_STAFF_VISIBLE_CASE_ID to enable this optional staff-scope check.');
  });

  it('suggests the paired fixture env for resolved support reply checks', () => {
    expect(nextActionForResult({
      status: 'skip',
      name: 'staff: resolved support reply send is blocked',
      detail: 'both SUPPORT_CRM_STAFF_RESOLVED_CASE_ID and SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID are required',
    })).toBe('Set both SUPPORT_CRM_STAFF_RESOLVED_CASE_ID and SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID to verify the resolved-case reply guard.');
  });

  it('suggests fixture envs when strict full coverage fails', () => {
    expect(nextActionForResult({
      status: 'fail',
      name: 'preflight: full coverage required',
      detail: '2 optional checks skipped',
    })).toBe('Set the fixture/env values listed under Skipped optional checks, or unset SUPPORT_CRM_REQUIRE_FULL_COVERAGE when partial coverage is intentional.');
  });

  it('dry-runs strict release env without exposing full secrets', () => {
    const results = buildPreflightDryRunResults({
      SUPPORT_CRM_API_URL: 'https://worker.example',
      SUPPORT_CRM_ADMIN_ORIGIN: 'https://admin.example/support',
      SUPPORT_CRM_LINE_ACCOUNT_ID: 'line-1',
      SUPPORT_CRM_OWNER_API_KEY: 'owner-secret-123456',
      SUPPORT_CRM_STAFF_API_KEY: 'staff-secret-123456',
      SUPPORT_CRM_REQUIRE_FULL_COVERAGE: '1',
      SUPPORT_CRM_STAFF_VISIBLE_CASE_ID: 'case-visible',
      SUPPORT_CRM_STAFF_FORBIDDEN_CASE_ID: 'case-forbidden',
      SUPPORT_CRM_STAFF_NON_RESOLVED_CASE_ID: 'case-nonresolved',
      SUPPORT_CRM_STAFF_RESOLVED_CASE_ID: 'case-resolved',
      SUPPORT_CRM_STAFF_VISIBLE_FRIEND_ID: 'friend-visible',
      SUPPORT_CRM_STAFF_FORBIDDEN_FRIEND_ID: 'friend-forbidden',
      SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID: 'friend-resolved',
    });
    const output = formatDryRunResults(results);

    expect(results.filter((item) => item.status === 'fail')).toEqual([]);
    expect(output).toContain('Support CRM preflight dry-run (no network requests).');
    expect(output).toContain('owner=owne...3456');
    expect(output).toContain('staff=staf...3456');
    expect(output).not.toContain('owner-secret-123456');
    expect(output).not.toContain('staff-secret-123456');
  });

  it('dry-runs strict release env and fails missing full-coverage inputs', () => {
    const results = buildPreflightDryRunResults({
      SUPPORT_CRM_API_URL: 'https://worker.example',
      SUPPORT_CRM_LINE_ACCOUNT_ID: 'line-1',
      SUPPORT_CRM_OWNER_API_KEY: 'owner-key',
      SUPPORT_CRM_REQUIRE_FULL_COVERAGE: '1',
      SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD: '0',
    });

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'fail',
        name: 'env: admin origin',
        detail: 'SUPPORT_CRM_ADMIN_ORIGIN is not set',
      }),
      expect.objectContaining({
        status: 'fail',
        name: 'env: staff API key',
        detail: 'SUPPORT_CRM_STAFF_API_KEY is not set',
      }),
      expect.objectContaining({
        status: 'fail',
        name: 'env: staff mutation guard',
        detail: 'SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD=0',
      }),
      expect.objectContaining({
        status: 'fail',
        name: 'env: SUPPORT_CRM_STAFF_VISIBLE_CASE_ID',
      }),
    ]));
  });
});

describe('runSupportCrmPreflight', () => {
  it('checks owner and staff endpoints and blocks staff case/manual mutations', async () => {
    const calls: FetchCall[] = [];
    const results = await runSupportCrmPreflight(buildConfig(), createHappyFetch(calls));

    expect(failed(results)).toEqual([]);
    expect(results.filter((item) => item.status === 'skip').map((item) => item.name)).toEqual([
      'admin login CORS preflight',
    ]);

    const ownerCases = calls.find((call) => call.url.pathname === '/api/support/cases' && call.authorization === 'Bearer owner-key');
    expect(ownerCases?.url.searchParams.get('queue')).toBe('unresolved');
    expect(ownerCases?.url.searchParams.get('limit')).toBe('5');

    const staffCaseMutation = calls.find((call) => call.url.pathname === '/api/support/cases' && call.method === 'POST');
    expect(staffCaseMutation).toMatchObject({
      authorization: 'Bearer staff-key',
      contentType: 'application/json',
    });
    expect(staffCaseMutation?.body).toBeTypeOf('string');
    expect(JSON.parse(staffCaseMutation?.body as string)).toMatchObject({
      lineAccountId: 'line-1',
      title: 'preflight case creation guard',
    });
    expect(JSON.parse(staffCaseMutation?.body as string)).not.toHaveProperty('customerSummary');

    const staffManualMutation = calls.find((call) => call.url.pathname === '/api/support/manuals' && call.method === 'POST');
    expect(staffManualMutation).toMatchObject({
      authorization: 'Bearer staff-key',
      contentType: 'application/json',
    });
    expect(staffManualMutation?.body).toBeTypeOf('string');
    expect(JSON.parse(staffManualMutation?.body as string)).toMatchObject({
      lineAccountId: 'line-1',
      title: '',
      body: '',
    });

    const staffManualUpdateMutation = calls.find((call) => call.url.pathname === '/api/support/manuals/preflight-manual-mutation-guard-never-exists' && call.method === 'PATCH');
    expect(staffManualUpdateMutation).toMatchObject({
      authorization: 'Bearer staff-key',
      contentType: 'application/json',
    });
    expect(staffManualUpdateMutation?.body).toBeTypeOf('string');
    expect(JSON.parse(staffManualUpdateMutation?.body as string)).toMatchObject({
      lineAccountId: 'line-1',
      title: '',
    });

    const staffManualArchiveMutation = calls.find((call) => call.url.pathname === '/api/support/manuals/preflight-manual-mutation-guard-never-exists' && call.method === 'DELETE');
    expect(staffManualArchiveMutation).toMatchObject({
      authorization: 'Bearer staff-key',
    });
    expect(staffManualArchiveMutation?.url.searchParams.get('lineAccountId')).toBe('line-1');

    const mutationNames = results.filter((item) => item.name.startsWith('staff: manual ')).map((item) => item.name);
    expect(mutationNames).toEqual([
      'staff: manual creation is blocked',
      'staff: manual update is blocked',
      'staff: manual archive is blocked',
    ]);

    const staffRoutingMutation = calls.find((call) => call.url.pathname === '/api/support/cases/case-visible' && call.method === 'PATCH');
    expect(staffRoutingMutation).toMatchObject({
      authorization: 'Bearer staff-key',
      contentType: 'application/json',
    });
    expect(staffRoutingMutation?.body).toBeTypeOf('string');
    expect(JSON.parse(staffRoutingMutation?.body as string)).toMatchObject({
      lineAccountId: 'line-1',
      primaryAssignee: 'preflight forbidden assignee',
      priority: '__preflight_invalid_priority__',
    });

    const staffEscalationRoutingMutation = calls.find((call) => call.url.pathname === '/api/support/cases/case-visible/escalations' && call.method === 'POST');
    expect(staffEscalationRoutingMutation).toMatchObject({
      authorization: 'Bearer staff-key',
      contentType: 'application/json',
    });
    expect(staffEscalationRoutingMutation?.body).toBeTypeOf('string');
    expect(JSON.parse(staffEscalationRoutingMutation?.body as string)).toMatchObject({
      lineAccountId: 'line-1',
      assignee: 'preflight forbidden escalation assignee',
      level: 'L3',
      question: '',
    });

    const staffInvalidReopen = calls.find((call) => call.url.pathname === '/api/support/cases/case-nonresolved' && call.method === 'PATCH');
    expect(staffInvalidReopen).toMatchObject({
      authorization: 'Bearer staff-key',
      contentType: 'application/json',
    });
    expect(staffInvalidReopen?.body).toBeTypeOf('string');
    expect(JSON.parse(staffInvalidReopen?.body as string)).toMatchObject({
      lineAccountId: 'line-1',
      status: 'reopened',
    });

    const staffResolvedSendGuard = calls.find((call) => call.url.pathname === '/api/chats/friend-resolved/send/validate' && call.method === 'POST');
    expect(staffResolvedSendGuard).toMatchObject({
      authorization: 'Bearer staff-key',
      contentType: 'application/json',
    });
    expect(staffResolvedSendGuard?.body).toBeTypeOf('string');
    expect(JSON.parse(staffResolvedSendGuard?.body as string)).toMatchObject({
      lineAccountId: 'line-1',
      supportCaseId: 'case-resolved',
      content: 'preflight resolved support reply guard',
    });

    const staffUnsupportedMessageType = calls.find((call) => call.url.pathname === '/api/chats/friend-visible/send/validate' && call.method === 'POST');
    expect(staffUnsupportedMessageType).toMatchObject({
      authorization: 'Bearer staff-key',
      contentType: 'application/json',
    });
    expect(staffUnsupportedMessageType?.body).toBeTypeOf('string');
    expect(JSON.parse(staffUnsupportedMessageType?.body as string)).toMatchObject({
      messageType: 'sticker',
      content: JSON.stringify({ packageId: '1', stickerId: '1' }),
    });

    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'GET',
        authorization: 'Bearer staff-key',
        url: expect.objectContaining({ pathname: '/api/friends/friend-visible/messages' }),
      }),
      expect.objectContaining({
        method: 'GET',
        authorization: 'Bearer staff-key',
        url: expect.objectContaining({ pathname: '/api/friends/friend-forbidden/messages' }),
      }),
      expect.objectContaining({
        method: 'GET',
        authorization: 'Bearer staff-key',
        url: expect.objectContaining({ pathname: '/api/friends/friend-visible/score' }),
      }),
      expect.objectContaining({
        method: 'GET',
        authorization: 'Bearer staff-key',
        url: expect.objectContaining({ pathname: '/api/friends/friend-forbidden/score' }),
      }),
      expect.objectContaining({
        method: 'GET',
        authorization: 'Bearer staff-key',
        url: expect.objectContaining({ pathname: '/api/friends/friend-visible/reminders' }),
      }),
      expect.objectContaining({
        method: 'GET',
        authorization: 'Bearer staff-key',
        url: expect.objectContaining({ pathname: '/api/friends/friend-forbidden/reminders' }),
      }),
    ]));
  });

  it('checks credentialed browser-login CORS preflight when admin origin is set', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = createHappyFetch(calls);
    const results = await runSupportCrmPreflight(
      buildConfig({ adminOrigin: 'https://admin.example', credentials: [{ role: 'owner', apiKey: 'owner-key' }] }),
      async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.pathname === '/api/auth/login' && init?.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': 'https://admin.example',
              'Access-Control-Allow-Credentials': 'true',
              'Access-Control-Allow-Headers': 'content-type, x-csrf-token',
            },
          });
        }
        return fetchImpl(input, init);
      },
    );

    expect(failed(results)).toEqual([]);
    expect(results).toContainEqual(expect.objectContaining({
      status: 'pass',
      name: 'admin login CORS preflight',
      detail: 'https://admin.example',
    }));
    expect(calls.some((call) => call.url.pathname === '/api/auth/login' && call.method === 'OPTIONS')).toBe(false);
  });

  it('fails the CORS preflight check when credentials are missing', async () => {
    const results = await runSupportCrmPreflight(
      buildConfig({ adminOrigin: 'https://admin.example', credentials: [{ role: 'owner', apiKey: 'owner-key' }] }),
      async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.pathname === '/api/auth/login' && init?.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': 'https://admin.example',
              'Access-Control-Allow-Headers': 'content-type',
            },
          });
        }
        return createHappyFetch()(input, init);
      },
    );

    expect(failed(results)).toEqual([
      expect.objectContaining({
        name: 'admin login CORS preflight',
        detail: 'expected Access-Control-Allow-Credentials true, got missing',
      }),
    ]);
  });

  it('skips optional staff fixture checks when fixture ids are not set', async () => {
    const results = await runSupportCrmPreflight(
      buildConfig({
        credentials: [{ role: 'staff', apiKey: 'staff-key' }],
        staffVisibleCaseId: undefined,
        staffForbiddenCaseId: undefined,
        staffVisibleFriendId: undefined,
        staffForbiddenFriendId: undefined,
        checkStaffMutationGuard: false,
      }),
      createHappyFetch(),
    );

    expect(failed(results)).toEqual([]);
    expect(results.filter((item) => item.status === 'skip').map((item) => item.name)).toEqual([
      'admin login CORS preflight',
      'staff: visible case can be opened',
      'staff: forbidden case is hidden',
      'staff: visible chat can be opened',
      'staff: unsupported chat message type is blocked',
      'staff: visible friend direct history can be opened',
      'staff: visible friend score can be opened',
      'staff: visible friend reminders can be opened',
      'staff: forbidden chat is hidden',
      'staff: forbidden friend direct history is hidden',
      'staff: forbidden friend score is hidden',
      'staff: forbidden friend reminders are hidden',
    ]);
  });

  it('fails full-coverage mode when optional checks are skipped', async () => {
    const results = await runSupportCrmPreflight(
      buildConfig({
        credentials: [{ role: 'staff', apiKey: 'staff-key' }],
        adminOrigin: undefined,
        staffVisibleCaseId: undefined,
        staffForbiddenCaseId: undefined,
        staffVisibleFriendId: undefined,
        staffForbiddenFriendId: undefined,
        checkStaffMutationGuard: false,
        requireFullCoverage: true,
      }),
      createHappyFetch(),
    );

    expect(failed(results)).toEqual([
      expect.objectContaining({
        name: 'preflight: owner/admin credential required',
        detail: 'SUPPORT_CRM_OWNER_API_KEY or SUPPORT_CRM_ADMIN_API_KEY is required when SUPPORT_CRM_REQUIRE_FULL_COVERAGE=1',
      }),
      expect.objectContaining({
        name: 'preflight: staff mutation guard required',
        detail: 'SUPPORT_CRM_CHECK_STAFF_MUTATION_GUARD must stay enabled when SUPPORT_CRM_REQUIRE_FULL_COVERAGE=1',
      }),
      expect.objectContaining({
        name: 'preflight: full coverage required',
        detail: '12 optional checks skipped',
      }),
    ]);
  });

  it('fails full-coverage mode when staff credential is missing or mutation guard is disabled', async () => {
    const results = await runSupportCrmPreflight(
      buildConfig({
        credentials: [{ role: 'owner', apiKey: 'owner-key' }],
        adminOrigin: 'https://admin.example',
        checkStaffMutationGuard: false,
        requireFullCoverage: true,
      }),
      async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.pathname === '/api/auth/login' && init?.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': 'https://admin.example',
              'Access-Control-Allow-Credentials': 'true',
              'Access-Control-Allow-Headers': 'content-type',
            },
          });
        }
        return createHappyFetch()(input, init);
      },
    );

    expect(failed(results)).toEqual([
      expect.objectContaining({
        name: 'preflight: staff credential required',
      }),
      expect.objectContaining({
        name: 'preflight: staff mutation guard required',
      }),
    ]);
  });

  it('skips the resolved support reply guard when only one fixture id is set', async () => {
    const results = await runSupportCrmPreflight(
      buildConfig({
        credentials: [{ role: 'staff', apiKey: 'staff-key' }],
        staffResolvedCaseId: 'case-resolved',
        staffResolvedFriendId: undefined,
      }),
      createHappyFetch(),
    );

    expect(failed(results)).toEqual([]);
    expect(results).toContainEqual({
      status: 'skip',
      name: 'staff: resolved support reply send is blocked',
      detail: 'both SUPPORT_CRM_STAFF_RESOLVED_CASE_ID and SUPPORT_CRM_STAFF_RESOLVED_FRIEND_ID are required',
    });
  });

  it('fails when the API key belongs to a different role than declared', async () => {
    const results = await runSupportCrmPreflight(
      buildConfig({
        credentials: [{ role: 'staff', apiKey: 'owner-key' }],
        checkStaffMutationGuard: false,
        staffVisibleCaseId: undefined,
        staffForbiddenCaseId: undefined,
        staffVisibleFriendId: undefined,
        staffForbiddenFriendId: undefined,
      }),
      createHappyFetch(),
    );

    expect(failed(results)).toEqual([
      expect.objectContaining({
        name: 'staff: login identity',
        detail: 'expected role staff, got owner',
      }),
    ]);
  });

  it('fails staff preflight when the staff name is blank', async () => {
    const results = await runSupportCrmPreflight(
      buildConfig({
        credentials: [{ role: 'staff', apiKey: 'staff-key' }],
        checkStaffMutationGuard: false,
        staffVisibleCaseId: undefined,
        staffForbiddenCaseId: undefined,
        staffVisibleFriendId: undefined,
        staffForbiddenFriendId: undefined,
      }),
      async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        if (headers.get('Authorization') !== 'Bearer staff-key') {
          return jsonResponse(401, { success: false, error: 'unauthorized' });
        }
        if (url.pathname === '/api/staff/me') return successObject({ role: 'staff', name: '   ' });
        if (url.pathname === '/api/capabilities') return successObject({ role: 'staff' });
        if (url.pathname === '/api/support/summary') return successObject({ open: 0 });
        if (url.pathname === '/api/support/cases') return successArray();
        if (url.pathname === '/api/support/manuals' && method === 'GET') return successArray();
        if (url.pathname === '/api/chats') return successArray();
        return jsonResponse(404, { success: false, error: 'not found' });
      },
    );

    expect(failed(results)).toEqual([
      expect.objectContaining({
        name: 'staff: login identity',
        detail: 'staff name is required for support visibility checks',
      }),
    ]);
  });

  it('fails when an expected array endpoint does not return a success array', async () => {
    const results = await runSupportCrmPreflight(
      buildConfig({ credentials: [{ role: 'owner', apiKey: 'owner-key' }] }),
      async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        if (url.pathname === '/api/support/manuals') {
          return jsonResponse(200, { success: true, data: { id: 'not-an-array' } });
        }
        return createHappyFetch()(input, init);
      },
    );

    expect(failed(results)).toEqual([
      expect.objectContaining({
        name: 'owner: support manuals',
        detail: 'expected 200 success array, got 200',
      }),
    ]);
  });
});
