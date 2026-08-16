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
