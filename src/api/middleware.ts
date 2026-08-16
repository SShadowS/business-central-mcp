import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  BCError,
  DeviceLoginRequiredError,
  UrlElicitationRequiredError,
  errorHint,
} from '../core/errors.js';

const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5 MB

export function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const AUTH_REQUIRED_CODES = new Set([
  'SIGN_IN_REQUIRED',
  'DEVICE_LOGIN_REQUIRED',
  'URL_ELICITATION_REQUIRED',
  'AUTHENTICATION_ERROR',
  'OAUTH_NOT_CONFIGURED',
]);
const UNAVAILABLE_CODES = new Set(['CONNECTION_ERROR', 'TIMEOUT_ERROR', 'SESSION_LOST']);

/**
 * Translate an error thrown by a REST request (including session creation
 * inside ensureReady) into an HTTP status + JSON body. Sign-in-flow errors
 * keep their code and payload (verification URL, user code, elicitations) —
 * the same information the MCP path surfaces — instead of collapsing into
 * an opaque 500.
 */
export function bcErrorToHttp(e: unknown): { status: number; body: Record<string, unknown> } {
  if (!(e instanceof BCError)) {
    return { status: 500, body: { error: e instanceof Error ? e.message : 'Internal error' } };
  }
  const body: Record<string, unknown> = { error: e.message, code: e.code };
  const hint = errorHint(e.code);
  if (hint) body['hint'] = hint;
  if (e instanceof DeviceLoginRequiredError) {
    body['verificationUri'] = e.verificationUri;
    body['userCode'] = e.userCode;
    body['expiresAt'] = e.expiresAt;
  }
  if (e instanceof UrlElicitationRequiredError) {
    body['elicitations'] = e.elicitations;
  }
  const status = AUTH_REQUIRED_CODES.has(e.code) ? 401
    : UNAVAILABLE_CODES.has(e.code) ? 503
    : 500;
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
