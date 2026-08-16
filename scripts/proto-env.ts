/**
 * Shared env access for proto scripts. There is deliberately NO default
 * tenant/environment — every probe must be pointed at a target explicitly.
 */
export function requireBaseUrl(): string {
  const raw = (process.env.BC_BASE_URL ?? '').replace(/\/+$/, '');
  if (!raw) {
    process.stderr.write(
      'FAIL: BC_BASE_URL is required, e.g. '
      + 'BC_BASE_URL=https://businesscentral.dynamics.com/{aadTenant}/{environment}\n',
    );
    process.exit(1);
  }
  return raw;
}

export function requireClientId(): string {
  const raw = (process.env.BC_CLIENT_ID ?? '').trim();
  if (!raw) {
    process.stderr.write(
      'FAIL: BC_CLIENT_ID is required. Use a multi-tenant public Entra app with '
      + 'delegated Dynamics 365 Business Central user_impersonation.\n',
    );
    process.exit(1);
  }
  return raw;
}
