const LINE_CONTENT_API_BASE = 'https://api-data.line.me/v2/bot/message';

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface FetchAndStoreOptions {
  r2?: R2Bucket;
  files?: KVNamespace;
  /** workers 環境では globalThis.fetch を使う。テスト時に注入する。 */
  fetch?: typeof fetch;
  /** 公開 URL のベース (例: https://your-worker.your-subdomain.workers.dev) */
  workerUrl: string;
  channelAccessToken: string;
  accountId: string;
  messageId: string;
}

export interface IncomingImageRefs {
  originalContentUrl: string;
  previewImageUrl: string;
}

export type IncomingImagePersistenceFailure =
  | 'storage_unavailable'
  | 'line_fetch_failed'
  | 'line_content_unavailable'
  | 'unsupported_content_type'
  | 'content_read_failed'
  | 'storage_write_failed';

export type IncomingImagePersistenceResult =
  | { ok: true; refs: IncomingImageRefs }
  | { ok: false; reason: IncomingImagePersistenceFailure; status?: number };

export interface StoreIncomingImageOptions {
  r2?: R2Bucket;
  files?: KVNamespace;
  workerUrl: string;
  accountId: string;
  messageId: string;
  data: ArrayBuffer;
  contentType: string;
}

function incomingImageErrorKind(err: unknown): string {
  if (err instanceof TypeError) return 'network_error';
  if (err instanceof Error) return err.name || 'error';
  return typeof err;
}

function incomingImageKey(accountId: string, messageId: string, ext: string): string {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9-]/g, '_');
  const safeMessageId = messageId.replace(/[^a-zA-Z0-9-]/g, '_');
  return `incoming-${safeAccountId}-${safeMessageId}.${ext}`;
}

function incomingImageRefs(workerUrl: string, key: string): IncomingImageRefs {
  const base = workerUrl.replace(/\/$/, '');
  const url = `${base}/images/${key}`;
  return { originalContentUrl: url, previewImageUrl: url };
}

/**
 * Store an incoming LINE image in the persistent storage available to this
 * deployment. R2 is preferred, while FILES KV keeps installations without R2
 * from falling back to LINE's expiring Content API.
 */
export async function storeIncomingImage(
  opts: StoreIncomingImageOptions,
): Promise<IncomingImagePersistenceResult> {
  const normalizedContentType = opts.contentType.split(';')[0].trim().toLowerCase();
  const ext = CONTENT_TYPE_TO_EXT[normalizedContentType];
  if (!ext) {
    console.error('incoming-image: unsupported content-type');
    return { ok: false, reason: 'unsupported_content_type' };
  }
  if (!opts.r2 && !opts.files) {
    console.error('incoming-image: persistent storage unavailable');
    return { ok: false, reason: 'storage_unavailable' };
  }

  const key = incomingImageKey(opts.accountId, opts.messageId, ext);
  if (opts.r2) {
    try {
      await opts.r2.put(key, opts.data, {
        httpMetadata: { contentType: normalizedContentType },
        customMetadata: { originalFilename: 'LINE画像' },
      });
      return { ok: true, refs: incomingImageRefs(opts.workerUrl, key) };
    } catch (err) {
      console.error(`incoming-image: R2 put failed: ${incomingImageErrorKind(err)}`);
    }
  }

  if (opts.files) {
    try {
      await opts.files.put(key, opts.data, {
        metadata: {
          contentType: normalizedContentType,
          originalFilename: 'LINE画像',
        },
      });
      return { ok: true, refs: incomingImageRefs(opts.workerUrl, key) };
    } catch (err) {
      console.error(`incoming-image: KV put failed: ${incomingImageErrorKind(err)}`);
    }
  }

  return { ok: false, reason: 'storage_write_failed' };
}

export function mergeIncomingImageRefs(
  content: string,
  lineMessageId: string,
  refs: IncomingImageRefs,
): string {
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    // Older records can contain only "[画像]". Keep the message metadata below.
  }
  return JSON.stringify({
    ...current,
    lineMessageId,
    messageId: lineMessageId,
    mediaType: 'image',
    fileName: typeof current.fileName === 'string' && current.fileName.trim()
      ? current.fileName
      : 'LINE画像',
    ...refs,
  });
}

/**
 * LINE Content API から incoming 画像バイナリを取得し永続保存して URL を返す。
 * 失敗時は null を返し、呼び出し元は `[画像]` ラベルフォールバックを使う。
 */
export async function fetchAndStoreIncomingImageDetailed(
  opts: FetchAndStoreOptions,
): Promise<IncomingImagePersistenceResult> {
  if (!opts.r2 && !opts.files) {
    console.error('incoming-image: persistent storage unavailable');
    return { ok: false, reason: 'storage_unavailable' };
  }
  const fetcher = opts.fetch ?? fetch;

  let res: Response;
  try {
    res = await fetcher(`${LINE_CONTENT_API_BASE}/${opts.messageId}/content`, {
      headers: { Authorization: `Bearer ${opts.channelAccessToken}` },
    });
  } catch (err) {
    console.error(`incoming-image: fetch failed: ${incomingImageErrorKind(err)}`);
    return { ok: false, reason: 'line_fetch_failed' };
  }

  if (!res.ok) {
    console.error(`incoming-image: non-200: status=${res.status}`);
    return { ok: false, reason: 'line_content_unavailable', status: res.status };
  }

  const contentType = res.headers.get('Content-Type')?.split(';')[0].trim() ?? 'application/octet-stream';
  if (!CONTENT_TYPE_TO_EXT[contentType]) {
    console.error('incoming-image: unsupported content-type');
    return { ok: false, reason: 'unsupported_content_type' };
  }

  let data: ArrayBuffer;
  try {
    data = await res.arrayBuffer();
  } catch (err) {
    console.error(`incoming-image: arrayBuffer failed: ${incomingImageErrorKind(err)}`);
    return { ok: false, reason: 'content_read_failed' };
  }

  return storeIncomingImage({
    r2: opts.r2,
    files: opts.files,
    workerUrl: opts.workerUrl,
    accountId: opts.accountId,
    messageId: opts.messageId,
    data,
    contentType,
  });
}

export async function fetchAndStoreIncomingImage(
  opts: FetchAndStoreOptions,
): Promise<IncomingImageRefs | null> {
  const result = await fetchAndStoreIncomingImageDetailed(opts);
  return result.ok ? result.refs : null;
}
