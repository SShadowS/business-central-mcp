import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { BCError, errorHint } from '../core/errors.js';

const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * A client-fault request error carrying the HTTP status it should map to
 * (400 malformed body, 413 too large) so the catch-all does not report a
 * client mistake as a 500 server fault.
 */
export class HttpRequestError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

export function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_SIZE) {
        req.destroy();
        reject(new HttpRequestError('Request body too large', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch { reject(new HttpRequestError('Invalid JSON body', 400)); }
    });
    req.on('error', reject);
  });
}

/**
 * Translate an error from the REST path — thrown (including session creation
 * inside ensureReady) or returned on the Result channel — into an HTTP
 * status + JSON body. Sign-in-flow errors keep their code and payload
 * (verification URL, user code, elicitations, openedWindow/reason,
 * fieldErrors, …) — the same information the MCP path surfaces — instead of
 * collapsing into an opaque 500. The status comes from flags on the class
 * (authRequired → 401, transient → 503), never a code list here; the body
 * comes from context plus the class's own toJSON() extras, never a per-class
 * field ladder. `fallbackStatus` covers the rest: 500 on the thrown path,
 * 400 on the Result channel (an operation-level failure is the caller's
 * request failing).
 */
export function bcErrorToHttp(e: unknown, fallbackStatus = 500): { status: number; body: Record<string, unknown> } {
  if (e instanceof HttpRequestError) {
    return { status: e.statusCode, body: { error: e.message } };
  }
  if (!(e instanceof BCError)) {
    const duck = e as { message?: unknown; code?: unknown } | undefined;
    const body: Record<string, unknown> = {
      error: typeof duck?.message === 'string'
        ? duck.message
        : (fallbackStatus === 500 ? 'Internal error' : undefined),
    };
    if (typeof duck?.code === 'string') body['code'] = duck.code;
    return { status: fallbackStatus, body };
  }
  const { name: _name, message: _message, timestamp: _timestamp, context, ...extras } =
    e.toJSON() as { name?: unknown; message?: unknown; timestamp?: unknown; context?: Record<string, unknown> };
  const body: Record<string, unknown> = { ...context, ...extras };
  body['error'] = e.message;
  body['code'] = e.code;
  const hint = errorHint(e.code);
  if (hint) body['hint'] = hint;
  const status = e.authRequired ? 401
    : e.transient ? 503
    : fallbackStatus;
  return { status, body };
}

export function checkApiToken(req: IncomingMessage, apiToken: string | undefined): boolean {
  if (!apiToken) return true; // No token required
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return false;
  const expected = Buffer.from(`Bearer ${apiToken}`, 'utf8');
  const actual = Buffer.from(auth, 'utf8');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
