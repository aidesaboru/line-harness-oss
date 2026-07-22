import type { Context, MiddlewareHandler } from 'hono';

const CREDENTIAL_ALLOW_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS';
const DEFAULT_ALLOW_HEADERS = 'Content-Type, Authorization, X-CSRF-Token, X-File-Name, Idempotency-Key';
const ALLOWED_REQUEST_HEADERS = new Map([
  ['content-type', 'Content-Type'],
  ['authorization', 'Authorization'],
  ['x-csrf-token', 'X-CSRF-Token'],
  ['x-file-name', 'X-File-Name'],
  ['idempotency-key', 'Idempotency-Key'],
]);

function allowedPreflightHeaders(requested: string | undefined): string {
  if (!requested) return DEFAULT_ALLOW_HEADERS;
  const allowed = requested
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => ALLOWED_REQUEST_HEADERS.has(item))
    .map((item) => ALLOWED_REQUEST_HEADERS.get(item)!);
  return allowed.length > 0 ? Array.from(new Set(allowed)).join(', ') : DEFAULT_ALLOW_HEADERS;
}

export function writeCredentialedPreflightHeaders(c: Context, origin: string): void {
  if (!origin) return;
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Access-Control-Allow-Methods', CREDENTIAL_ALLOW_METHODS);
  c.header('Access-Control-Allow-Headers', allowedPreflightHeaders(c.req.header('Access-Control-Request-Headers')));
  c.header('Access-Control-Max-Age', '600');
  c.header('Vary', 'Origin, Access-Control-Request-Headers');
}

function appendVary(c: Context, value: string): void {
  const current = c.res.headers.get('Vary');
  if (!current) {
    c.header('Vary', value);
    return;
  }
  const values = current.split(',').map((item) => item.trim().toLowerCase());
  if (!values.includes(value.toLowerCase())) c.header('Vary', `${current}, ${value}`);
}

export function credentialedCors(resolveOrigin: (origin: string | undefined, c: Context) => string): MiddlewareHandler {
  return async (c, next) => {
    const origin = resolveOrigin(c.req.header('Origin'), c);

    if (c.req.method === 'OPTIONS') {
      writeCredentialedPreflightHeaders(c, origin);
      return c.body(null, 204);
    }

    await next();

    if (origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
      appendVary(c, 'Origin');
    }
  };
}
