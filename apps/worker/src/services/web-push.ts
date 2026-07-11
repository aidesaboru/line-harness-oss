const encoder = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

export type WebPushEnv = {
  WEB_PUSH_VAPID_PUBLIC_KEY?: string;
  WEB_PUSH_VAPID_PRIVATE_KEY?: string;
  WEB_PUSH_CONTACT?: string;
  ADMIN_PUBLIC_URL?: string;
};

export type WebPushSubscriptionRecord = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type WebPushPayload = {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string;
  createdAt: string;
};

export type WebPushSendResult = {
  ok: boolean;
  status: number;
  expired: boolean;
  error?: string;
};

const WEB_PUSH_RECORD_SIZE = 4096;
const MAX_PUSH_BODY_LENGTH = 180;

function normalizeBase64Url(value: string): string {
  return value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
}

function makeBytes(length: number): Bytes {
  return new Uint8Array(new ArrayBuffer(length)) as Bytes;
}

export function base64UrlDecode(value: string): Bytes {
  const binary = atob(normalizeBase64Url(value.trim()));
  const bytes = makeBytes(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64UrlEncode(input: ArrayBuffer | Uint8Array<ArrayBufferLike>): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function concatBytes(...parts: Uint8Array<ArrayBufferLike>[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = makeBytes(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hmacSha256(keyBytes: Uint8Array<ArrayBufferLike>, data: Uint8Array<ArrayBufferLike>): Promise<Bytes> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data)) as Bytes;
}

async function hkdfExtract(salt: Uint8Array<ArrayBufferLike>, ikm: Uint8Array<ArrayBufferLike>): Promise<Bytes> {
  return hmacSha256(salt, ikm);
}

async function hkdfExpand(prk: Uint8Array<ArrayBufferLike>, info: Uint8Array<ArrayBufferLike>, length: number): Promise<Bytes> {
  const chunks: Bytes[] = [];
  let previous = makeBytes(0);
  let produced = 0;
  let counter = 1;
  while (produced < length) {
    previous = await hmacSha256(prk, concatBytes(previous, info, new Uint8Array([counter])));
    chunks.push(previous);
    produced += previous.length;
    counter += 1;
  }
  return concatBytes(...chunks).slice(0, length);
}

function publicKeyJwk(publicKey: string): { x: string; y: string } {
  const bytes = base64UrlDecode(publicKey);
  if (bytes.length !== 65 || bytes[0] !== 4) {
    throw new Error('invalid_vapid_public_key');
  }
  return {
    x: base64UrlEncode(bytes.slice(1, 33)),
    y: base64UrlEncode(bytes.slice(33, 65)),
  };
}

async function createVapidJwt(env: WebPushEnv, endpoint: string): Promise<string> {
  const publicKey = (env.WEB_PUSH_VAPID_PUBLIC_KEY ?? '').trim();
  const privateKey = (env.WEB_PUSH_VAPID_PRIVATE_KEY ?? '').trim();
  if (!publicKey || !privateKey) throw new Error('web_push_not_configured');
  const { x, y } = publicKeyJwk(publicKey);
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x,
      y,
      d: privateKey,
      ext: false,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const endpointUrl = new URL(endpoint);
  const aud = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const sub = (env.WEB_PUSH_CONTACT || env.ADMIN_PUBLIC_URL || 'mailto:line-harness@example.com').trim();
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = base64UrlEncode(encoder.encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub,
  })));
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function encryptPayload(subscription: WebPushSubscriptionRecord, payload: WebPushPayload): Promise<Uint8Array> {
  const userPublicKey = base64UrlDecode(subscription.p256dh);
  const authSecret = base64UrlDecode(subscription.auth);
  const userKey = await crypto.subtle.importKey(
    'raw',
    userPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const serverKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  ) as CryptoKeyPair;
  const serverPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey) as ArrayBuffer);
  const subtle = crypto.subtle as unknown as {
    deriveBits(
      algorithm: { name: string; public: CryptoKey },
      baseKey: CryptoKey,
      length: number,
    ): Promise<ArrayBuffer>;
  };
  const sharedSecret = new Uint8Array(await subtle.deriveBits(
    { name: 'ECDH', public: userKey },
    serverKeys.privateKey,
    256,
  )) as Bytes;

  const prkKey = await hkdfExtract(authSecret, sharedSecret);
  const ikm = await hkdfExpand(
    prkKey,
    concatBytes(encoder.encode('WebPush: info\0'), userPublicKey, serverPublicKey),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, encoder.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const body = {
    ...payload,
    body: payload.body.slice(0, MAX_PUSH_BODY_LENGTH),
  };
  const plaintext = concatBytes(encoder.encode(JSON.stringify(body)), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    aesKey,
    plaintext,
  ));

  const header = new Uint8Array(16 + 4 + 1 + serverPublicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, WEB_PUSH_RECORD_SIZE, false);
  header[20] = serverPublicKey.length;
  header.set(serverPublicKey, 21);
  return concatBytes(header, ciphertext);
}

export function isWebPushConfigured(env: WebPushEnv): boolean {
  return Boolean((env.WEB_PUSH_VAPID_PUBLIC_KEY ?? '').trim() && (env.WEB_PUSH_VAPID_PRIVATE_KEY ?? '').trim());
}

export async function sendWebPush(
  env: WebPushEnv,
  subscription: WebPushSubscriptionRecord,
  payload: WebPushPayload,
): Promise<WebPushSendResult> {
  if (!isWebPushConfigured(env)) {
    return { ok: false, status: 0, expired: false, error: 'web_push_not_configured' };
  }
  let body: Uint8Array;
  let vapidJwt: string;
  try {
    body = await encryptPayload(subscription, payload);
    vapidJwt = await createVapidJwt(env, subscription.endpoint);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      expired: false,
      error: err instanceof Error ? err.message : 'web_push_encrypt_failed',
    };
  }

  let res: Response;
  try {
    res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${vapidJwt}, k=${(env.WEB_PUSH_VAPID_PUBLIC_KEY ?? '').trim()}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '3600',
        Urgency: payload.kind === 'urgent_case' ? 'high' : 'normal',
      },
      body,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      expired: false,
      error: err instanceof Error ? err.message : 'web_push_fetch_failed',
    };
  }

  if (res.status >= 200 && res.status < 300) {
    return { ok: true, status: res.status, expired: false };
  }
  const errorText = await res.text().catch(() => '');
  return {
    ok: false,
    status: res.status,
    expired: res.status === 404 || res.status === 410,
    error: errorText.slice(0, 240) || `push_service_${res.status}`,
  };
}
