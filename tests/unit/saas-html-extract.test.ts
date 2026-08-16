import { describe, it, expect } from 'vitest';
import {
  parseBalancedObject,
  parseConfig,
  parseFixedEndPoint,
  extractInputs,
  extractForm,
  isRemoteSignIn,
  extractFceToken,
  pageInfo,
  extractFixedEndPointAuth,
} from '../../src/connection/auth/saas/html-extract.js';
import { redactLog } from '../../src/connection/auth/saas/redact.js';

const FIXTURE_JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.sig';

describe('parseBalancedObject / parseConfig', () => {
  it('parses $Config= with nested braces', () => {
    const html = `<script>$Config={"sFT":"tok","urlPost":"/t/login","arrUserProofs":[{"authMethodId":"PhoneAppNotification"}],"nested":{"a":1}};</script>`;
    const cfg = parseConfig(html);
    expect(cfg?.['sFT']).toBe('tok');
    expect(cfg?.['urlPost']).toBe('/t/login');
    expect(cfg?.['arrUserProofs']).toEqual([{ authMethodId: 'PhoneAppNotification' }]);
    expect((cfg?.['nested'] as { a: number }).a).toBe(1);
  });

  it('returns undefined when $Config is missing or not JSON', () => {
    expect(parseConfig('<html></html>')).toBeUndefined();
    expect(parseBalancedObject('no-brace', 0)).toBeUndefined();
    expect(parseConfig('$Config={not-json}')).toBeUndefined();
  });
});

describe('parseFixedEndPoint', () => {
  it('extracts FixedEndPoint.start object including authentication.accessToken', () => {
    const html = `FixedEndPoint.start({"environment":"DEV","authentication":{"type":"aad","accessToken":"${FIXTURE_JWT}"}});`;
    const fp = parseFixedEndPoint(html);
    expect(fp?.['environment']).toBe('DEV');
    const auth = extractFixedEndPointAuth(fp!);
    expect(auth.accessToken).toBe(FIXTURE_JWT);
  });

  it('does not echo the access token through redactLog', () => {
    const { msg, context } = redactLog('boot', { accessToken: FIXTURE_JWT });
    expect(msg).not.toContain(FIXTURE_JWT);
    expect(JSON.stringify(context)).not.toContain(FIXTURE_JWT);
  });
});

describe('extractForm / isRemoteSignIn', () => {
  it('decodes HTML entities in the form action and finds remote-sign-in + code', () => {
    const html = `
      <form action="https://businesscentral.dynamics.com/remote-sign-in?x=1&amp;y=2">
        <input name="code" value="abc&amp;def">
        <input name="state" value="s">
      </form>`;
    const form = extractForm(html);
    expect(form?.action).toBe('https://businesscentral.dynamics.com/remote-sign-in?x=1&y=2');
    expect(form?.fields['code']).toBe('abc&def');
    expect(isRemoteSignIn(form!)).toBe(true);
  });

  it('treats a code field as remote-sign-in even if action is relative', () => {
    const html = `<form action="/callback"><input name="code" value="x"></form>`;
    const form = extractForm(html);
    expect(isRemoteSignIn(form!)).toBe(true);
  });

  it('returns undefined without a form action', () => {
    expect(extractForm('<input name="code" value="x">')).toBeUndefined();
  });
});

describe('extractInputs', () => {
  it('reads name/value in either attribute order', () => {
    const html = `<input value="v1" name="a"><input name="b" value="v2">`;
    expect(extractInputs(html)).toEqual({ a: 'v1', b: 'v2' });
  });
});

describe('extractFceToken', () => {
  it('reads #RequestVerificationToken with id then value', () => {
    const html = `<input id="RequestVerificationToken" value="tok-id-first">`;
    expect(extractFceToken(html)).toBe('tok-id-first');
  });

  it('reads #RequestVerificationToken with value then id', () => {
    const html = `<input value="tok-value-first" id="RequestVerificationToken">`;
    expect(extractFceToken(html)).toBe('tok-value-first');
  });

  it('returns empty string when absent', () => {
    expect(extractFceToken('<html></html>')).toBe('');
  });
});

describe('pageInfo', () => {
  it('reads pgid, hpgid, sErrTxt, and arrUserProofs', () => {
    const html = `$Config={"pgid":"ConvergedTFA","hpgid":1114,"sErrTxt":"bad","arrUserProofs":[{"authMethodId":"PhoneAppOTP"}]}`;
    expect(pageInfo(html)).toEqual({
      pgid: 'ConvergedTFA',
      hpgid: '1114',
      err: 'bad',
      proofs: ['PhoneAppOTP'],
    });
  });

  it('returns empty fields when $Config is missing', () => {
    expect(pageInfo('')).toEqual({ pgid: '', hpgid: '', err: '', proofs: [] });
  });
});
