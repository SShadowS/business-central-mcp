/**
 * Discover the SaaS /csh host from this machine's Chromium cookie *names*,
 * decrypt values via the OS keyring (never printed), and try the upgrade
 * on *.appservices.us.businesscentral.dynamics.com.
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function chromiumPassword(): string {
  const out = execFileSync('secret-tool', [
    'lookup', 'application', 'chromium',
  ], { encoding: 'utf8', timeout: 5000 }).trim();
  if (!out) throw new Error('empty chromium keyring password');
  return out;
}

function decryptValue(enc: Buffer, password: string): string | undefined {
  if (enc.length < 4) return undefined;
  const payload = enc.subarray(3);
  const key16 = pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
  const key32 = pbkdf2Sync(password, 'saltysalt', 1, 32, 'sha1');
  const raw16 = Buffer.from(password, 'base64');
  const keys: Buffer[] = [key16, key32];
  if (raw16.length === 16 || raw16.length === 32) keys.push(raw16);

  const tries: Array<() => Buffer> = [];
  for (const key of keys) {
    if (key.length === 16) {
      tries.push(() => {
        const c = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
        return Buffer.concat([c.update(payload), c.final()]);
      });
    }
    const gcmAlg = key.length === 32 ? 'aes-256-gcm' : key.length === 16 ? 'aes-128-gcm' : null;
    if (gcmAlg && payload.length > 28) {
      tries.push(() => {
        const nonce = payload.subarray(0, 12);
        const tag = payload.subarray(payload.length - 16);
        const data = payload.subarray(12, payload.length - 16);
        const c = createDecipheriv(gcmAlg, key, nonce);
        c.setAuthTag(tag);
        return Buffer.concat([c.update(data), c.final()]);
      });
    }
  }
  for (const t of tries) {
    try {
      const pt = t();
      const s = pt.toString('utf8');
      if (s.length > 0 && !/[\x00-\x08]/.test(s.slice(0, 8))) return s;
    } catch { /* next */ }
  }
  return undefined;
}

interface CookieRow {
  host: string;
  name: string;
  path: string;
  value: string;
}

function loadCookies(password: string): CookieRow[] {
  const src = `${process.env.HOME}/.config/chromium/Default/Cookies`;
  const dir = mkdtempSync(join(tmpdir(), 'bc-ck-'));
  const copy = join(dir, 'Cookies');
  try {
    copyFileSync(src, copy);
    const sql = `SELECT host_key, name, path, hex(encrypted_value)
      FROM cookies
      WHERE host_key LIKE '%businesscentral.dynamics.com%'`;
    const raw = execFileSync('sqlite3', ['-separator', '\t', copy, sql], { encoding: 'utf8' });
    const rows: CookieRow[] = [];
    const lines = raw.split('\n').filter(Boolean);
    let decrypted = 0;
    let parseFail = 0;
    for (const line of lines) {
      const [host, name, path, hex] = line.split('\t');
      if (!host || !name || !hex) { parseFail += 1; continue; }
      const buf = Buffer.from(hex, 'hex');
      const value = decryptValue(buf, password);
      if (value && !/[\u0100-\uFFFF]/.test(value)) {
        decrypted += 1;
        rows.push({ host, name, path: path ?? '/', value });
      }
    }
    log(`decrypted ${decrypted} / ${lines.length} businesscentral cookies (parseFail=${parseFail})`);
    return rows;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function headerForHost(rows: CookieRow[], host: string): string {
  const map = new Map<string, string>();
  for (const r of rows) {
    const rh = r.host.replace(/^\./, '');
    if (host === rh || host.endsWith(`.${rh}`) || rh === host) {
      map.set(r.name, r.value);
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function csrfFrom(header: string): string {
  for (const part of header.split('; ')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const n = part.slice(0, eq).toLowerCase();
    const v = part.slice(eq + 1);
    if (n.includes('antiforgery')) return v;
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
  log('Prototype: Chromium cookie jar → appservices /csh');
  const password = chromiumPassword();
  const rows = loadCookies(password);
  const hosts = [...new Set(rows.map((r) => r.host.replace(/^\./, '')))];
  log(`hosts: ${hosts.join(', ')}`);
  for (const h of hosts) {
    const names = rows.filter((r) => r.host.includes(h.replace(/^\./, ''))).map((r) => r.name);
    log(`  ${h}: ${[...new Set(names)].join(', ')}`);
  }

  const appHosts = hosts.filter((h) => h.includes('appservices') && h.includes('businesscentral'));
  const portalCookie = headerForHost(rows, 'businesscentral.dynamics.com');
  log(`portal cookie names: ${portalCookie.split('; ').map((p) => p.split('=')[0]).join(', ') || '(none)'}`);

  if (!portalCookie && appHosts.length === 0) {
    log('FAIL: no decryptable BC cookies');
    process.exit(1);
  }

  let opened = false;
  const ua = { 'User-Agent': 'BCMCPServer/2.0' };

  if (portalCookie) {
    const origin = 'https://businesscentral.dynamics.com';
    const headers = { Cookie: portalCookie, Origin: origin, ...ua };
    log('\n[portal] GET /7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV');
    log(`  ${await http('https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV', headers)}`);
    log('[portal] GET /…/csh');
    log(`  ${await http('https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/DEV/csh', headers)}`);
    log('[portal] GET /{tenant}/csh');
    log(`  ${await http('https://businesscentral.dynamics.com/7bcb54ae-6d5e-43c7-9402-928aed68ad00/csh', headers)}`);
    const csrf = csrfFrom(portalCookie);
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
  }

  for (const host of appHosts) {
    const cookie = headerForHost(rows, host);
    if (!cookie) continue;
    const originA = `https://${host}`;
    const originB = 'https://businesscentral.dynamics.com';
    const csrf = csrfFrom(cookie);
    const qs = new URLSearchParams({ ackseqnb: '-1' });
    if (csrf) qs.set('csrftoken', csrf);
    log(`\n[appservices] ${host}`);
    for (const origin of [originA, originB]) {
      const headers = { Cookie: cookie, Origin: origin, ...ua };
      log(`  GET /csh Origin=${origin}`);
      log(`    ${await http(`https://${host}/csh`, headers)}`);
      const r = await probeWs(`wss://${host}/csh?${qs}`, headers);
      log(`  WS /csh Origin=${origin} → ${r}`);
      if (r.startsWith('OPEN')) opened = true;
    }
  }

  if (opened) {
    log('\nPASS: /csh opened using the local Chromium session');
    process.exit(0);
  }
  log('\nFAIL: had cluster hosts / cookies but /csh did not upgrade');
  process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
