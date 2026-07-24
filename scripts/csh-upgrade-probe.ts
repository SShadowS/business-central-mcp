/**
 * /csh WebSocket-upgrade diagnostic.
 *
 * Prints the auth material this client produces and the responses from BOTH a
 * plain GET and a real WebSocket upgrade against `${BC_BASE_URL}/csh`, so a
 * 403/400 on the upgrade can be diagnosed without a full session.
 *
 * Companion to docs/investigations/2026-07-24-bc283-csh-403.md.
 *
 * Run:
 *   BC_BASE_URL=http://cronus28/BC  BC_USERNAME=sshadows BC_PASSWORD=1234 BC_TENANT_ID=default npx tsx scripts/csh-upgrade-probe.ts   # BC 28.3 — currently 403
 *   BC_BASE_URL=http://cronus281/BC BC_USERNAME=sshadows BC_PASSWORD=1234 BC_TENANT_ID=default npx tsx scripts/csh-upgrade-probe.ts   # BC 28.0 — known good
 */
import WebSocket from 'ws';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { loadConfig } from '../src/core/config.js';
import { isErr } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`base=${cfg.bc.baseUrl}  clientVersion=${cfg.bc.clientVersionString}  serverMajor=${cfg.bc.serverMajor}`);

  const auth = new NTLMAuthProvider(
    { baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId },
    quiet,
  );
  const authResult = await auth.authenticate();
  if (isErr(authResult)) { console.log('AUTH ERR:', authResult.error.message); process.exit(1); }
  console.log(`auth ok: cookie ${authResult.value.cookies.length}B, csrf ${authResult.value.csrfToken.length}B`);

  const headers = auth.getWebSocketHeaders();          // { Cookie }
  const query = auth.getWebSocketQueryParams();         // { csrftoken }
  const qs = Object.entries({ ...query, ackseqnb: '-1' })
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const httpUrl = `${cfg.bc.baseUrl}/csh?${qs}`;
  const wsUrl = httpUrl.replace(/^http/, 'ws');
  console.log(`csh url: ${httpUrl.slice(0, 110)}…`);
  console.log(`ws headers: ${Object.keys(headers).join(', ')}`);

  // --- 1) plain GET (no upgrade) — shows the server's own error page --------
  const getRes = await fetch(httpUrl, { headers: { ...headers, 'User-Agent': 'BCMCPServer/2.0' }, redirect: 'manual' });
  console.log(`\n[plain GET]  ${getRes.status} ${getRes.statusText}`);
  console.log(`  resp headers: ${[...getRes.headers.entries()].map(([k, v]) => `${k}=${v.slice(0, 40)}`).join(' | ')}`);
  console.log(`  body[0..300]: ${(await getRes.text()).slice(0, 300).replace(/\s+/g, ' ')}`);

  // --- 2) real WS upgrade — the path the client actually uses ---------------
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(wsUrl, { headers });
    const done = (label: string) => { console.log(`[ws upgrade] ${label}`); try { ws.close(); } catch {} resolve(); };
    ws.on('upgrade', (res) => {
      console.log(`\n[ws upgrade] HTTP ${res.statusCode} ${res.statusMessage} (101 = success)`);
      console.log(`  resp headers: ${Object.entries(res.headers).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(' | ')}`);
    });
    // ws emits 'unexpected-response' for any non-101 — this is where the 403 lands.
    ws.on('unexpected-response', (_req, res) => {
      console.log(`\n[ws upgrade] REJECTED: HTTP ${res.statusCode} ${res.statusMessage}`);
      console.log(`  resp headers: ${Object.entries(res.headers).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(' | ')}`);
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => { console.log(`  body[0..400]: ${body.slice(0, 400).replace(/\s+/g, ' ')}`); done('(rejected)'); });
    });
    ws.on('open', () => done('OPEN — handshake succeeded'));
    ws.on('error', (e) => done(`ERROR — ${e.message}`));
    setTimeout(() => done('TIMEOUT (10s)'), 10_000);
  });

  process.exit(0);
}

main().catch((e) => { console.error('PROBE CRASHED:', e); process.exit(1); });
