import type { BCConfig } from '../core/config.js';

/**
 * The probe `SessionFactory` runs, or undefined when BC_APPLICATION_ID is set or
 * the target is BC Online (SaasWeb: host is businesscentral.dynamics.com, FIN).
 */
export function applicationIdProbeFor(bc: BCConfig): (() => Promise<string | undefined>) | undefined {
  if (bc.applicationId || bc.authMode === 'SaasWeb') return undefined;
  return () => probeApplicationId(bc.baseUrl, bc.tenantId);
}

/**
 * Reads the `navigationContext.applicationId` the web client would send, from the
 * client configuration the web server embeds in its boot script. The server picks
 * it in `HttpDomainHelper.EvaluateApplicationIdTypeFromUrlHost` (decompiled
 * Microsoft.Dynamics.Nav.Types): host name (financials/accountants.dynamics), then
 * `?aid=` (FIN/ACC only), then the server's `DefaultApplicationId` setting, which is
 * `NAV` on on-prem containers. Serialized by `ClientConfigurationBuilder.Build`.
 * The boot script is served without sign-in (verified live cronus29: 200, `"ApplicationId":"FIN"`).
 */
export async function probeApplicationId(
  baseUrl: string,
  tenantId: string,
  timeoutMs = 10_000,
): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseUrl}/boot/browser/desktop?tenant=${encodeURIComponent(tenantId)}`, {
      redirect: 'manual',
      headers: { 'User-Agent': 'BCMCPServer/2.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    return parseApplicationId(await res.text());
  } catch {
    return undefined;
  }
}

/** `"ApplicationId":"X"`; the leading quote excludes `"DefaultApplicationId"`. */
export function parseApplicationId(bootScript: string): string | undefined {
  return /"ApplicationId":"([A-Za-z]+)"/.exec(bootScript)?.[1];
}
