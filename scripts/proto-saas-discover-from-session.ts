/**
 * Headless read of the already-logged-in pw-profile: which portal HTTP
 * calls reveal the appservices /tenant/msft…/tab/… URL. Research only.
 */
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { ensureChromium } from '../src/connection/auth/ensure-chromium.js';
import { parseSaasUrl } from '../src/connection/saas-url.js';
import { requireBaseUrl } from './proto-env.js';


function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

async function main(): Promise<void> {
  const saas = parseSaasUrl(requireBaseUrl());
  if (!saas) throw new Error('bad url');
  const stateDir = resolve(process.env.STATE_DIR || './.state');
  process.env.PLAYWRIGHT_BROWSERS_PATH = ensureChromium(stateDir);
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(resolve(stateDir, 'pw-profile'), {
    headless: true,
  });
  const hits: string[] = [];
  const page = context.pages()[0] ?? await context.newPage();
  page.on('response', async (res) => {
    const u = res.url();
    if (/appservices|\/tenant\/msft|clientservices|product|environment|boot/i.test(u)) {
      hits.push(`${res.status()} ${u.split('?')[0]}`);
    }
  });
  await page.goto(saas.portalUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(8000);
  const html = await page.content();
  writeFileSync('/tmp/bc-portal-session.html', html);
  log(`page url ${page.url()}`);
  log(`html bytes ${html.length}`);
  const urls = [...html.matchAll(/https?:\/\/[^"'\\s<>]+/g)].map((m) => m[0]!);
  const interesting = [...new Set(urls.filter((u) => /appservices|msft1|csh|tenant\//i.test(u)))];
  log(`html urls (${interesting.length}):`);
  for (const u of interesting.slice(0, 40)) log(`  ${u.split('?')[0]}`);
  for (const key of ['serviceUrl', 'serverUrl', 'cluster', 'appservices', 'msft1', 'tabId', 'tenantId']) {
    if (html.toLowerCase().includes(key.toLowerCase())) log(`html mentions ${key}`);
  }
  const needle = html.indexOf('msft1');
  if (needle >= 0) {
    log(`html around msft1: ${html.slice(Math.max(0, needle - 180), needle + 220).replace(/\s+/g, ' ')}`);
  }
  log('network hits:');
  for (const h of hits.slice(0, 60)) log(`  ${h}`);
  await context.close();
}

main().catch((e) => {
  process.stderr.write(`FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
