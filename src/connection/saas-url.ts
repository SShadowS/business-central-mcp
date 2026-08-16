/**
 * SaaS (BC Online) URL parsing.
 *
 * Portal URLs look like:
 *   https://businesscentral.dynamics.com/{aadTenantId}/{environment}
 *   https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV
 *
 * That host is Azure Front Door, not the NST. OData/API lives at
 *   https://api.businesscentral.dynamics.com/v2.0/{aadTenantId}/{environment}
 *
 * Verified live 2026-08-15 against a DEV sandbox: unauthenticated GET of the
 * portal URL 302s to login.microsoftonline.com with first-party client
 * 996def3d-b36c-4153-8607-a6fd3c01b89f and redirect_uri
 * https://businesscentral.dynamics.com/remote-sign-in (OpenID Connect,
 * response_mode=form_post). Unauthenticated GET of {portal}/csh returns 404
 * (x-servicefabric: ResourceNotFound) — the /csh upgrade is only routed after
 * a web-client session exists.
 */

const SAAS_HOST = /^(?:[a-z0-9-]+\.)?businesscentral\.dynamics\.com$/i;
const AAD_TENANT_GUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// BC Online also accepts a verified AAD domain in the tenant path segment
// (e.g. contoso.onmicrosoft.com or contoso.com). A tenant domain always
// contains at least one dot, which distinguishes it from non-tenant path
// segments like "admin" or an environment name.
const AAD_TENANT_DOMAIN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;

export interface SaasTarget {
  aadTenantId: string;
  environmentName: string;
  /** Canonical portal URL, no trailing slash or extra path. */
  portalUrl: string;
  /** Standard API v2.0 base (no /api/v2.0 suffix — ODataClient appends that). */
  odataUrl: string;
  origin: string;
}

export function isSaasHost(hostname: string): boolean {
  return SAAS_HOST.test(hostname);
}

export function isEntraLoginUrl(urlOrHost: string): boolean {
  let host = urlOrHost;
  try {
    if (urlOrHost.includes('://')) host = new URL(urlOrHost).hostname;
  } catch {
    return false;
  }
  const h = host.toLowerCase();
  return h === 'login.microsoftonline.com'
    || h === 'login.windows.net'
    || h === 'login.microsoft.com'
    || h.endsWith('.microsoftonline.com');
}

export function parseSaasUrl(raw: string): SaasTarget | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (!isSaasHost(url.hostname)) return undefined;

  const parts = url.pathname.split('/').filter(Boolean);
  // /{tenant}/{environment}[/*]
  if (parts.length < 2) return undefined;
  const tenant = parts[0]!;
  const environment = parts[1]!;
  if (!AAD_TENANT_GUID.test(tenant) && !AAD_TENANT_DOMAIN.test(tenant)) return undefined;
  if (!environment || environment.toLowerCase() === 'api') return undefined;

  const aadTenantId = tenant.toLowerCase();
  return {
    aadTenantId,
    environmentName: environment,
    portalUrl: `https://businesscentral.dynamics.com/${aadTenantId}/${environment}`,
    odataUrl: `https://api.businesscentral.dynamics.com/v2.0/${aadTenantId}/${environment}`,
    origin: 'https://businesscentral.dynamics.com',
  };
}
