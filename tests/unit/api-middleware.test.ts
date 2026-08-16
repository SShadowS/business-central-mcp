import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { parseJsonBody, checkApiToken, bcErrorToHttp } from '../../src/api/middleware.js';
import {
  ConnectionError,
  DeviceLoginRequiredError,
  ProtocolError,
  SessionLostError,
  SignInRequiredError,
  UrlElicitationRequiredError,
} from '../../src/core/errors.js';
import type { IncomingMessage } from 'node:http';

// ---------------------------------------------------------------------------
// parseJsonBody
// ---------------------------------------------------------------------------

function makeReadable(chunks: Buffer[]): IncomingMessage {
  return Readable.from(
    (async function* () {
      for (const c of chunks) yield c;
    })()
  ) as unknown as IncomingMessage;
}

function makeErrorStream(error: Error): IncomingMessage {
  const stream = new Readable({ read() {} }) as unknown as IncomingMessage;
  setImmediate(() => (stream as unknown as Readable).destroy(error));
  return stream;
}

describe('parseJsonBody', () => {
  it('resolves to parsed object for a valid JSON payload', async () => {
    const req = makeReadable([Buffer.from('{"key":"value","num":42}')]);
    const result = await parseJsonBody(req);
    expect(result).toEqual({ key: 'value', num: 42 });
  });

  it('resolves to parsed array for a valid JSON array payload', async () => {
    const req = makeReadable([Buffer.from('[1,2,3]')]);
    const result = await parseJsonBody(req);
    expect(result).toEqual([1, 2, 3]);
  });

  it('resolves to parsed result when body is split across multiple chunks', async () => {
    const chunks = ['{"sp', 'lit":tr', 'ue}'].map(s => Buffer.from(s));
    const req = makeReadable(chunks);
    const result = await parseJsonBody(req);
    expect(result).toEqual({ split: true });
  });

  it('resolves to {} for an empty body', async () => {
    const req = makeReadable([]);
    const result = await parseJsonBody(req);
    expect(result).toEqual({});
  });

  it('rejects with "Invalid JSON body" for malformed JSON', async () => {
    const req = makeReadable([Buffer.from('{not valid json}')]);
    await expect(parseJsonBody(req)).rejects.toThrow('Invalid JSON body');
  });

  it('rejects when the stream emits an error', async () => {
    const streamError = new Error('stream failure');
    const req = makeErrorStream(streamError);
    await expect(parseJsonBody(req)).rejects.toThrow('stream failure');
  });
});

// ---------------------------------------------------------------------------
// checkApiToken
// ---------------------------------------------------------------------------

function makeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('checkApiToken', () => {
  it('returns true when apiToken is undefined (no auth required)', () => {
    const req = makeReq({});
    expect(checkApiToken(req, undefined)).toBe(true);
  });

  it('returns true when apiToken is empty string (no auth required)', () => {
    const req = makeReq({});
    expect(checkApiToken(req, '')).toBe(true);
  });

  it('returns true when Authorization header matches "Bearer <token>"', () => {
    const req = makeReq({ authorization: 'Bearer secret123' });
    expect(checkApiToken(req, 'secret123')).toBe(true);
  });

  it('returns false when Authorization header has the wrong token', () => {
    const req = makeReq({ authorization: 'Bearer wrongtoken' });
    expect(checkApiToken(req, 'secret123')).toBe(false);
  });

  it('returns false when Authorization header is missing', () => {
    const req = makeReq({});
    expect(checkApiToken(req, 'secret123')).toBe(false);
  });

  it('returns false when Authorization header uses a non-Bearer scheme', () => {
    const req = makeReq({ authorization: 'Basic secret123' });
    expect(checkApiToken(req, 'secret123')).toBe(false);
  });

  it('returns false when Authorization header is just the token without "Bearer " prefix', () => {
    const req = makeReq({ authorization: 'secret123' });
    expect(checkApiToken(req, 'secret123')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bcErrorToHttp
// ---------------------------------------------------------------------------

describe('bcErrorToHttp', () => {
  it('maps SignInRequiredError to 401 with its code', () => {
    const { status, body } = bcErrorToHttp(
      new SignInRequiredError('open the sign-in window', { openedWindow: true, reason: 'no_session' }),
    );
    expect(status).toBe(401);
    expect(body.code).toBe('SIGN_IN_REQUIRED');
    expect(body.error).toContain('sign-in window');
  });

  it('maps DeviceLoginRequiredError to 401 carrying the verification URL and user code', () => {
    const { status, body } = bcErrorToHttp(
      new DeviceLoginRequiredError('https://microsoft.com/devicelogin', 'ABC-123', Date.now() + 900_000),
    );
    expect(status).toBe(401);
    expect(body.code).toBe('DEVICE_LOGIN_REQUIRED');
    expect(body.verificationUri).toBe('https://microsoft.com/devicelogin');
    expect(body.userCode).toBe('ABC-123');
  });

  it('maps UrlElicitationRequiredError to 401 carrying the elicitations', () => {
    const elicitations = [{ mode: 'url' as const, elicitationId: 'e1', url: 'https://x', message: 'sign in' }];
    const { status, body } = bcErrorToHttp(new UrlElicitationRequiredError(elicitations));
    expect(status).toBe(401);
    expect(body.code).toBe('URL_ELICITATION_REQUIRED');
    expect(body.elicitations).toEqual(elicitations);
  });

  it('maps ConnectionError and SessionLostError to 503', () => {
    expect(bcErrorToHttp(new ConnectionError('portal unreachable')).status).toBe(503);
    expect(bcErrorToHttp(new SessionLostError('gone', [])).status).toBe(503);
  });

  it('maps other BCErrors to 500 with their code preserved', () => {
    const { status, body } = bcErrorToHttp(new ProtocolError('bad frame'));
    expect(status).toBe(500);
    expect(body.code).toBe('PROTOCOL_ERROR');
  });

  it('maps a plain Error to 500 with only the message', () => {
    const { status, body } = bcErrorToHttp(new Error('boom'));
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'boom' });
  });
});
