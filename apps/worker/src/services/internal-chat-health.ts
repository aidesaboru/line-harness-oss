const INTERNAL_CHAT_HEALTH_STATE_KEY = 'monitor:internal-chat-feed';
const INTERNAL_CHAT_HEALTH_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const SLACK_API_TIMEOUT_MS = 10_000;

type InternalChatHealthState = {
  status: 'healthy' | 'failed';
  checkedAt: string;
  lastAlertAt: string | null;
};

type InternalChatHealthStateStore = Pick<KVNamespace, 'get' | 'put'>;

export type InternalChatHealthRuntime = {
  db: D1Database;
  stateStore?: InternalChatHealthStateStore;
  slackBotToken?: string;
  slackChannelId?: string;
  adminPublicUrl?: string;
  now?: Date;
  sendSlackMessage?: (token: string, channelId: string, text: string) => Promise<void>;
};

export type InternalChatHealthResult = {
  status: 'healthy' | 'failed';
  alertSent: boolean;
  recoverySent: boolean;
};

function healthErrorKind(error: unknown): string {
  if (error instanceof TypeError) return 'network_error';
  if (error instanceof Error) return error.name || 'error';
  return typeof error;
}

async function readHealthState(
  store: InternalChatHealthStateStore | undefined,
): Promise<InternalChatHealthState | null> {
  if (!store) return null;
  try {
    const raw = await store.get(INTERNAL_CHAT_HEALTH_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<InternalChatHealthState>;
    if (
      (parsed.status !== 'healthy' && parsed.status !== 'failed')
      || typeof parsed.checkedAt !== 'string'
      || (parsed.lastAlertAt !== null && typeof parsed.lastAlertAt !== 'string')
    ) {
      return null;
    }
    return parsed as InternalChatHealthState;
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'internal_chat_health_state_read_failed',
      errorKind: healthErrorKind(error),
    }));
    return null;
  }
}

async function writeHealthState(
  store: InternalChatHealthStateStore | undefined,
  state: InternalChatHealthState,
): Promise<void> {
  if (!store) return;
  try {
    await store.put(INTERNAL_CHAT_HEALTH_STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'internal_chat_health_state_write_failed',
      errorKind: healthErrorKind(error),
    }));
  }
}

async function defaultSendSlackMessage(
  token: string,
  channelId: string,
  text: string,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SLACK_API_TIMEOUT_MS);
  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: channelId, text }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`slack_http_${response.status}`);
    const body = await response.json() as { ok?: boolean };
    if (body.ok !== true) throw new Error('slack_api_error');
  } finally {
    clearTimeout(timeout);
  }
}

async function sendHealthNotification(
  runtime: InternalChatHealthRuntime,
  text: string,
): Promise<boolean> {
  const token = runtime.slackBotToken?.trim();
  const channelId = runtime.slackChannelId?.trim();
  if (!token || !channelId || !runtime.stateStore) return false;
  const sender = runtime.sendSlackMessage ?? defaultSendSlackMessage;
  try {
    await sender(token, channelId, text);
    return true;
  } catch (error) {
    console.error(JSON.stringify({
      event: 'internal_chat_health_slack_failed',
      errorKind: healthErrorKind(error),
    }));
    return false;
  }
}

export async function checkInternalChatDataAccess(db: D1Database): Promise<void> {
  const row = await db.prepare(
    `SELECT
       EXISTS (
         SELECT 1
         FROM support_internal_messages sim
         INNER JOIN support_cases sc ON sc.id = sim.case_id
         LEFT JOIN friends f_support ON f_support.id = sc.friend_id
         LIMIT 1
       ) AS support_messages_ready,
       EXISTS (
         SELECT 1
         FROM chat_internal_messages cim
         LEFT JOIN friends f_chat ON f_chat.id = cim.friend_id
         LIMIT 1
       ) AS chat_messages_ready,
       EXISTS (SELECT 1 FROM internal_message_events LIMIT 1) AS events_ready,
       EXISTS (SELECT 1 FROM internal_message_mentions LIMIT 1) AS mentions_ready,
       EXISTS (SELECT 1 FROM internal_conversation_reads LIMIT 1) AS reads_ready,
       EXISTS (SELECT 1 FROM internal_message_bookmark_events LIMIT 1) AS bookmarks_ready,
       EXISTS (SELECT 1 FROM internal_tasks LIMIT 1) AS tasks_ready`,
  ).first<Record<string, number>>();
  if (!row) throw new Error('internal_chat_health_query_empty');
}

export async function monitorInternalChatHealth(
  runtime: InternalChatHealthRuntime,
): Promise<InternalChatHealthResult> {
  const now = runtime.now ?? new Date();
  const checkedAt = now.toISOString();
  const previous = await readHealthState(runtime.stateStore);
  try {
    await checkInternalChatDataAccess(runtime.db);
    let recoverySent = false;
    if (previous?.status === 'failed') {
      const url = runtime.adminPublicUrl?.trim()
        ? `\n${runtime.adminPublicUrl.replace(/\/$/, '')}/internal-chat`
        : '';
      recoverySent = await sendHealthNotification(
        runtime,
        `:white_check_mark: 社内チャットの取得処理が復旧しました${url}`,
      );
    }
    await writeHealthState(runtime.stateStore, {
      status: 'healthy',
      checkedAt,
      lastAlertAt: previous?.lastAlertAt ?? null,
    });
    console.log(JSON.stringify({ event: 'internal_chat_health_check', status: 'healthy' }));
    return { status: 'healthy', alertSent: false, recoverySent };
  } catch (error) {
    const previousAlertMs = previous?.lastAlertAt ? Date.parse(previous.lastAlertAt) : Number.NaN;
    const alertDue = previous?.status !== 'failed'
      || !Number.isFinite(previousAlertMs)
      || now.getTime() - previousAlertMs >= INTERNAL_CHAT_HEALTH_ALERT_COOLDOWN_MS;
    let alertSent = false;
    if (alertDue) {
      const url = runtime.adminPublicUrl?.trim()
        ? `\n${runtime.adminPublicUrl.replace(/\/$/, '')}/internal-chat`
        : '';
      alertSent = await sendHealthNotification(
        runtime,
        `:warning: 社内チャットの自動監視で取得処理の異常を検知しました${url}`,
      );
    }
    await writeHealthState(runtime.stateStore, {
      status: 'failed',
      checkedAt,
      lastAlertAt: alertSent ? checkedAt : previous?.lastAlertAt ?? null,
    });
    console.error(JSON.stringify({
      event: 'internal_chat_health_check',
      status: 'failed',
      errorKind: healthErrorKind(error),
      alertSent,
    }));
    return { status: 'failed', alertSent, recoverySent: false };
  }
}
