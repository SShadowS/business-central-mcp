import { describe, it, expect } from 'vitest';
import { redactLog } from '../../src/connection/auth/saas/redact.js';

describe('redactLog', () => {
  it('redacts password, passwd, cookies, authorization, and JWT prefixes in msg and context', () => {
    const { msg, context } = redactLog(
      'login passwd=s3cretPASS Cookie: a=1 authorization: Bearer eyJhbGciOiJub25l.aa.bb',
      {
        password: 's3cretPASS',
        accessToken: 'eyJfixture.payload.sig',
        flowToken: 'ft-1',
        canary: 'can-1',
        PPFT: 'ppft-1',
        sFT: 'sft-1',
        code: 'authz-code',
      },
    );
    const dumped = `${msg} ${JSON.stringify(context)}`;
    expect(dumped).not.toContain('s3cretPASS');
    expect(dumped).not.toContain('eyJhbGciOiJub25l');
    expect(dumped).not.toContain('eyJfixture');
    expect(dumped).not.toContain('ft-1');
    expect(dumped).not.toContain('can-1');
    expect(dumped).not.toContain('ppft-1');
    expect(dumped).not.toContain('sft-1');
    expect(dumped).not.toContain('authz-code');
  });

  it('leaves ordinary log text intact', () => {
    const { msg, context } = redactLog('saas-web: tab abc', { tabId: 'abc' });
    expect(msg).toBe('saas-web: tab abc');
    expect(context).toEqual({ tabId: 'abc' });
  });
});
