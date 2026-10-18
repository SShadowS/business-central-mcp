// Issue #41: an outage must not read as "reconnected" or as bad credentials.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { toBcErrorBody } from '../../src/mcp/error-envelope.js';
import { SessionLostError } from '../../src/core/errors.js';
import { NTLMAuthProvider } from '../../src/connection/auth/ntlm-provider.js';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('issue #41 error mapping', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('SESSION_LOST with reconnectFailed does not claim the session was reconnected', () => {
    const failed = toBcErrorBody('bc_open_page', new SessionLostError('gone', [], { reconnectFailed: true }));
    expect(failed.nextSteps[0]).not.toMatch(/was reconnected/);
    expect(failed.nextSteps[0]).toMatch(/reconnecting to BC failed/);
    const recovered = toBcErrorBody('bc_open_page', new SessionLostError('gone', []));
    expect(recovered.nextSteps[0]).toMatch(/was reconnected/);
  });

  it('NTLM sign-in that cannot reach BC is a retryable connection error, not an auth failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const auth = new NTLMAuthProvider({ baseUrl: 'http://bc.test/BC', username: 'u', password: 'p', tenantId: 'default' }, logger);
    const res = await auth.authenticate();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('CONNECTION_ERROR');
    const body = toBcErrorBody('bc_close_page', res.ok ? { message: '' } : res.error);
    expect(body.error).toMatchObject({ code: 'ENDPOINT_UNREACHABLE', retryable: true });
  });
});
