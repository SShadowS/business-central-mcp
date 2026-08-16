import { describe, it, expect } from 'vitest';
import { parseSaasUrl, isSaasHost } from '../../src/connection/saas-url.js';

const TENANT = '7bcb54ae-6d5e-43c7-9402-928aed68ad00';

describe('isSaasHost', () => {
  it('matches the public portal', () => {
    expect(isSaasHost('businesscentral.dynamics.com')).toBe(true);
  });
  it('matches regional subdomains', () => {
    expect(isSaasHost('weu.businesscentral.dynamics.com')).toBe(true);
  });
  it('rejects on-prem hosts', () => {
    expect(isSaasHost('cronus28')).toBe(false);
    expect(isSaasHost('demoportaldev.continiaonline.com')).toBe(false);
  });
});

describe('parseSaasUrl', () => {
  it('parses tenant GUID + environment', () => {
    const t = parseSaasUrl(`https://businesscentral.dynamics.com/${TENANT}/DEV`);
    expect(t).toEqual({
      aadTenantId: TENANT,
      environmentName: 'DEV',
      portalUrl: `https://businesscentral.dynamics.com/${TENANT}/DEV`,
      odataUrl: `https://api.businesscentral.dynamics.com/v2.0/${TENANT}/DEV`,
      origin: 'https://businesscentral.dynamics.com',
    });
  });

  it('strips trailing slash, query, and extra path', () => {
    const t = parseSaasUrl(`https://businesscentral.dynamics.com/${TENANT}/DEV/?company=CRONUS`);
    expect(t?.environmentName).toBe('DEV');
    expect(t?.portalUrl).toBe(`https://businesscentral.dynamics.com/${TENANT}/DEV`);
  });

  it('lowercases the tenant GUID', () => {
    const t = parseSaasUrl(`https://businesscentral.dynamics.com/${TENANT.toUpperCase()}/sandbox`);
    expect(t?.aadTenantId).toBe(TENANT);
  });

  it('returns undefined for on-prem URLs', () => {
    expect(parseSaasUrl('http://cronus28/BC')).toBeUndefined();
  });

  it('returns undefined when the path is not tenant/environment', () => {
    expect(parseSaasUrl('https://businesscentral.dynamics.com/')).toBeUndefined();
    expect(parseSaasUrl('https://businesscentral.dynamics.com/not-a-guid/DEV')).toBeUndefined();
  });

  it('returns undefined for garbage', () => {
    expect(parseSaasUrl('not a url')).toBeUndefined();
  });
});
