import { describe, it, expect } from 'vitest';
import { CookieJar } from '../../src/connection/auth/saas/cookie-jar.js';

const TENANT = '7bcb54ae-6d5e-43c7-9402-928aed68ad00';
const PORTAL = `https://businesscentral.dynamics.com/${TENANT}/DEV`;
const ESTS = 'https://login.microsoftonline.com/common/login';
const CLUSTER = 'https://msft1eu2as5743-3mujv5i.appservices.us.businesscentral.dynamics.com/tenant/msft/tab/t';

function response(setCookies: string[]): Response {
  const headers = new Headers();
  for (const c of setCookies) headers.append('set-cookie', c);
  return new Response(null, { headers });
}

describe('CookieJar', () => {
  it('absorbs two portal Set-Cookie values and returns them for the portal host', () => {
    const jar = new CookieJar();
    jar.absorb(response([
      `${TENANT}.auth=portal-auth; Path=/; Secure`,
      `${TENANT}.Antiforgery.FCE=fce; Path=/; Secure`,
    ]), PORTAL);
    const header = jar.headerFor(PORTAL);
    expect(header).toContain(`${TENANT}.auth=portal-auth`);
    expect(header).toContain(`${TENANT}.Antiforgery.FCE=fce`);
    expect(jar.hasPortalAuth()).toBe(true);
  });

  it('rejects a Set-Cookie scoped to a bare public suffix so it cannot over-scope', () => {
    const jar = new CookieJar();
    jar.absorb(response(['tracker=1; Domain=com; Path=/; Secure']), PORTAL);
    // A Domain of a bare public suffix (e.g. "com") would otherwise attach to
    // every *.com host the jar contacts. It must not be stored at all.
    expect(jar.headerFor(PORTAL)).not.toContain('tracker');
    expect(jar.headerFor('https://evil.example.com/')).not.toContain('tracker');
  });

  it('keeps a Set-Cookie scoped to a real registrable domain (dynamics.com)', () => {
    const jar = new CookieJar();
    jar.absorb(response(['shared=1; Domain=businesscentral.dynamics.com; Path=/; Secure']), PORTAL);
    expect(jar.headerFor(PORTAL)).toContain('shared=1');
  });

  it('does not send ESTSAUTH from login.microsoftonline.com to the cluster', () => {
    const jar = new CookieJar();
    jar.absorb(response([
      'ESTSAUTH=ests-secret; Domain=login.microsoftonline.com; Path=/; Secure',
      'ESTSAUTHPERSISTENT=long; Domain=.login.microsoftonline.com; Path=/; Secure',
    ]), ESTS);
    jar.absorb(response([
      `${TENANT}.auth=portal-auth; Path=/; Secure`,
    ]), PORTAL);
    const clusterHeader = jar.headerFor(CLUSTER);
    expect(clusterHeader).not.toContain('ESTSAUTH');
    expect(clusterHeader).not.toContain('ests-secret');
    expect(jar.headerFor(ESTS)).toContain('ESTSAUTH=ests-secret');
  });

  it('hasPortalAuth is true for {tid}.auth', () => {
    const jar = new CookieJar();
    expect(jar.hasPortalAuth()).toBe(false);
    jar.absorb(response([`${TENANT}.auth=x; Path=/`]), PORTAL);
    expect(jar.hasPortalAuth()).toBe(true);
  });

  it('hasPortalAuth matches the resolved-GUID auth cookie for a domain-form tenant', () => {
    // A domain-form portal URL (contoso.onmicrosoft.com) still gets a cookie
    // named by the resolved AAD GUID; presence must not depend on the
    // configured tenant id spelling.
    const jar = new CookieJar();
    jar.absorb(response([`${TENANT}.auth=x; Path=/`]), 'https://businesscentral.dynamics.com/contoso.onmicrosoft.com/DEV');
    expect(jar.hasPortalAuth()).toBe(true);
    jar.clearPortalAuth();
    expect(jar.hasPortalAuth()).toBe(false);
    expect(jar.headerFor(PORTAL)).not.toContain(`${TENANT}.auth`);
  });

  it('hasPortalAuth ignores a *.auth cookie on a non-portal host', () => {
    const jar = new CookieJar();
    jar.absorb(response(['msft.auth=x; Path=/']), CLUSTER);
    expect(jar.hasPortalAuth()).toBe(false);
  });

  it('hasPortalAuth ignores non-auth portal cookies', () => {
    const jar = new CookieJar();
    jar.absorb(response([`${TENANT}.Antiforgery.FCE=fce; Path=/`]), PORTAL);
    expect(jar.hasPortalAuth()).toBe(false);
  });

  it('hasPortalAuth is true for .AspNetCore.Cookies on the portal host', () => {
    const jar = new CookieJar();
    jar.absorb(response(['.AspNetCore.Cookies=sess; Path=/']), PORTAL);
    expect(jar.hasPortalAuth()).toBe(true);
  });

  it('persistable() drops ESTS-domain cookies and keeps portal cookies', () => {
    const jar = new CookieJar();
    jar.absorb(response(['ESTSAUTH=x; Domain=login.microsoftonline.com; Path=/; Secure']), ESTS);
    jar.absorb(response([`${TENANT}.auth=keep; Path=/; Secure`]), PORTAL);
    const saved = jar.persistable();
    expect(saved.some((c) => c.name === 'ESTSAUTH')).toBe(false);
    expect(saved.some((c) => c.name === `${TENANT}.auth` && c.value === 'keep')).toBe(true);
  });

  it('persistable() drops appservices cluster cookies', () => {
    const jar = new CookieJar();
    jar.absorb(response(['.AspNetCore.Cookies=cluster; Path=/; Secure']), CLUSTER);
    expect(jar.persistable().some((c) => c.name === '.AspNetCore.Cookies')).toBe(false);
  });

  it('round-trips persistable records through load', () => {
    const jar = new CookieJar();
    jar.absorb(response([`${TENANT}.auth=keep; Path=/; Secure`]), PORTAL);
    const other = new CookieJar();
    other.load(jar.persistable());
    expect(other.hasPortalAuth()).toBe(true);
    expect(other.headerFor(PORTAL)).toContain(`${TENANT}.auth=keep`);
  });

  it('omits expired cookies from headerFor', () => {
    const jar = new CookieJar();
    jar.absorb(response(['dead=1; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']), PORTAL);
    expect(jar.headerFor(PORTAL)).not.toContain('dead=');
  });

  it('lists cookie names', () => {
    const jar = new CookieJar();
    jar.absorb(response(['a=1; Path=/', 'b=2; Path=/']), PORTAL);
    expect(jar.names().sort()).toEqual(['a', 'b']);
  });
});
