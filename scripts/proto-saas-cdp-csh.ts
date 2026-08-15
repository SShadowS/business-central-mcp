/**
 * Read the already-logged-in Chromium profile via DevTools (no Puppeteer),
 * then try /csh on portal + *.appservices.us.businesscentral.dynamics.com.
 * Cookie values are never printed.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') { reject(new Error('port')); return; }
      const p = addr.port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
}

function cdpCall(ws: WebSocket, id: number, method: string, params?: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMsg = (data: WebSocket.RawData) => {
      const msg = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id !== id) return;
      ws.off('message', onMsg);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error(`cdp timeout ${method}`)), 15_000);
  });
}

async function waitJson(url: string, attempts = 40): Promise<Record<string, unknown>> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json() as Record<string, unknown>;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`no CDP at ${url}`);
}

function headerFor(cookies: CdpCookie[], host: string): string {
  const map = new Map<string, string>();
  for (const c of cookies) {
    const d = c.domain.replace(/^\./, '');
    if (host === d || host.endsWith(`.${d}`)) map.set(c.name, c.value);
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function csrfFrom(header: string): string {
  for (const part of header.split('; ')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).toLowerCase().includes('antiforgery')) {
      return part.slice(eq + 1);
    }
  }
  return '';
}

function probeWs(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const done = (d: string) => { try { ws.close(); } catch { /* */ } resolve(d); };
    ws.on('open', () => done('OPEN 101'));
    ws.on('unexpected-response', (_req, res) => done(`REJECTED HTTP ${res.statusCode}`));
    ws.on('error', (e) => done(`ERROR ${e.message}`));
    setTimeout(() => done('TIMEOUT'), 10_000);
  });
}

async function http(url: string, headers: Record<string, string>): Promise<string> {
  const res = await fetch(url, { redirect: 'manual', headers });
  const loc = (res.headers.get('location') ?? '').split('?')[0];
  await res.arrayBuffer();
  return `HTTP ${res.status} loc=${loc || '-'} sf=${res.headers.get('x-servicefabric') ?? '-'}`;
}

async function main(): Promise<void> {
  const home = process.env.HOME ?? '';
  const src = join(home, '.config/chromium');
  const dir = join(tmpdir(), `bc-cdp-${Date.now()}`);
  mkdirSync(join(dir, 'Default'), { recursive: true });
  cpSync(join(src, 'Local State'), join(dir, 'Local State'));
  cpSync(join(src, 'Default/Cookies'), join(dir, 'Default/Cookies'));
  try { cpSync(join(src, 'Default/Cookies-journal'), join(dir, 'Default/Cookies-journal')); } catch { /* */ }

  const port = await freePort();
  log(`Prototype: CDP cookie read from Chromium profile copy (port ${port})`);
  const child = spawn('chromium', [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
    '--disable-sync',
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=127.0.0.1`,
    `--user-data-dir=${dir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });

  try {
    const ver = await waitJson(`http://127.0.0.1:${port}/json/version`);
    const wsUrl = String(ver.webSocketDebuggerUrl ?? '');
    if (!wsUrl) throw new Error(`no browser ws: ${JSON.stringify(ver)}`);
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
      setTimeout(() => reject(new Error('browser ws connect timeout')), 10_000);
    });

    let cookies: CdpCookie[] = [];
    try {
      const r = await cdpCall(ws, 1, 'Storage.getCookies') as { cookies?: CdpCookie[] };
      cookies = r.cookies ?? [];
    } catch (e) {
      log(`Storage.getCookies failed (${e instanceof Error ? e.message : e}); trying page Network.getAllCookies`);
      const pages = await waitJson(`http://127.0.0.1:${port}/json/list`) as unknown as Array<{ webSocketDebuggerUrl?: string }>;
      const pageWsUrl = pages[0]?.webSocketDebuggerUrl;
      if (!pageWsUrl) throw e;
      const pws = new WebSocket(pageWsUrl);
      await new Promise<void>((resolve, reject) => {
        pws.on('open', () => resolve());
        pws.on('error', reject);
      });
      await cdpCall(pws, 1, 'Network.enable');
      const r = await cdpCall(pws, 2, 'Network.getAllCookies') as { cookies?: CdpCookie[] };
      cookies = r.cookies ?? [];
      pws.close();
    }
    ws.close();

    const bc = cookies.filter((c) => c.domain.includes('businesscentral.dynamics.com'));
    log(`CDP cookies total=${cookies.length} businesscentral=${bc.length}`);
    const hosts = [...new Set(bc.map((c) => c.domain.replace(/^\./, '')))];
    for (const h of hosts) {
      const names = bc.filter((c) => c.domain.replace(/^\./, '') === h || c.domain === `.${h}`).map((c) => c.name);
      log(`  ${h}: ${names.join(', ')}`);
    }

    const appHosts = hosts.filter((h) => h.includes('appservices'));
    const ua = { 'User-Agent': 'BCMCPServer/2.0' };
    let opened = false;

    const portal = headerFor(bc, 'businesscentral.dynamics.com');
    if (portal) {
      const headers = { Cookie: portal, Origin: 'https://businesscentral.dynamics.com', ...ua };
      log('\n[portal] GET /tenant/DEV');
      log(`  ${await http('https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV', headers)}`);
      const csrf = csrfFrom(portal);
      const qs = new URLSearchParams({ ackseqnb: '-1' });
      if (csrf) qs.set('csrftoken', csrf);
      for (const path of [
        `/7bcb54ae-6d5e-43c7-9402-928aed68ad00/csh?${qs}`,
        `/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV/csh?${qs}`,
      ]) {
        const r = await probeWs(`wss://businesscentral.dynamics.com${path}`, headers);
        log(`[portal] WS ${path.split('?')[0]} → ${r}`);
        if (r.startsWith('OPEN')) opened = true;
      }
    } else {
      log('no portal cookies');
    }

    for (const host of appHosts) {
      const cookie = headerFor(bc, host);
      if (!cookie) continue;
      const csrf = csrfFrom(cookie);
      const qs = new URLSearchParams({ ackseqnb: '-1' });
      if (csrf) qs.set('csrftoken', csrf);
      log(`\n[appservices] ${host}`);
      for (const origin of [`https://${host}`, 'https://businesscentral.dynamics.com']) {
        const headers = { Cookie: cookie, Origin: origin, ...ua };
        log(`  GET /csh Origin=${origin}`);
        log(`    ${await http(`https://${host}/csh`, headers)}`);
        const r = await probeWs(`wss://${host}/csh?${qs}`, headers);
        log(`  WS /csh Origin=${origin} → ${r}`);
        if (r.startsWith('OPEN')) opened = true;
      }
    }

    if (opened) {
      log('\nPASS: /csh opened with the local Chromium web-client session');
      process.exitCode = 0;
    } else {
      log('\nFAIL: CDP had cookies but /csh did not upgrade');
      process.exitCode = 1;
    }
  } catch (e) {
    log(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
    if (stderr.trim()) log(`chromium stderr: ${stderr.slice(-400)}`);
    process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 500);
    setTimeout(() => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
      process.exit(process.exitCode ?? 1);
    }, 800);
  }
}

main();
