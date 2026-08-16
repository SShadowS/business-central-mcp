/**
 * Fallback device-code client for the BC Standard API (`bc_query`) — the
 * Azure PowerShell well-known public app (same as New-BcAuthContext
 * -includeDeviceLogin). Entra's first-party hardening is phasing this out:
 * hardened tenants reject ANY borrowed Microsoft client at sign-in with
 * AADSTS65002, which no tenant admin can consent around (verified live
 * 2026-08-16, tenant-dependent). Production use should set BC_CLIENT_ID to
 * a publisher-owned MULTI-TENANT public app (delegated user_impersonation
 * on resource 996def3d-b36c-4153-8607-a6fd3c01b89f) — a third-party app is
 * structurally immune to 65002 and customers register nothing.
 */
export const BC_API_PUBLIC_CLIENT_ID = '1950a258-227b-4e31-a9cf-717495945fc2';
export const BC_API_DELEGATED_SCOPE =
  'https://api.businesscentral.dynamics.com/user_impersonation offline_access';
