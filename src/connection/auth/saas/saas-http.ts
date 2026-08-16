import { ConnectionError } from '../../../core/errors.js';
import type { CookieJar } from './cookie-jar.js';
import { SAAS_BROWSER_UA } from './ests-types.js';

/**
 * The one HTTP primitive for SaaS portal, cluster, and ESTS calls: browser
 * UA, jar cookies attached, manual redirects, Set-Cookie absorbed, body
 * drained — and a rejected fetch (DNS, socket, aborted body) surfaced as a
 * typed retryable ConnectionError so every caller classifies the same
 * outage the same way. Both SaasClusterSession.request and
 * EstsLoginClient.request delegate here; a header/redirect/error-policy
 * change lands once.
 */
export async function fetchWithJar(
  fetchFn: typeof fetch,
  jar: CookieJar,
  url: string,
  init: RequestInit = {},
): Promise<{ res: Response; html: string }> {
  const headers = new Headers(init.headers);
  headers.set('User-Agent', SAAS_BROWSER_UA);
  const cookie = jar.headerFor(url);
  if (cookie) headers.set('Cookie', cookie);
  try {
    const res = await fetchFn(url, { ...init, headers, redirect: 'manual' });
    jar.absorb(res, url);
    return { res, html: await res.text() };
  } catch (e) {
    throw new ConnectionError(
      `SaaS request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
