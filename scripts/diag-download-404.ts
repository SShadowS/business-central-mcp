/**
 * Diagnostic: does DynamicFileHandler.axd require the SAME auth session that
 * generated the WS connection, or does ANY valid authenticated cookie for the
 * same user work?
 *
 * Test A: one NTLMAuthProvider used for BOTH the WS session and the download GET.
 * Test B: two SEPARATE NTLMAuthProvider logins (same user) -- one for WS, one for GET
 *         (mirrors what report-capture.test.ts / download-capture.test.ts do today).
 *
 * Run: npx tsx scripts/diag-download-404.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { loadConfig } from '../src/core/config.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { BCHttpClient } from '../src/connection/bc-http.js';
import { isErr, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';
import type { BCEvent, FileDownloadReadyEvent } from '../src/protocol/types.js';

dotenvConfig();

const quiet: Logger = { debug: () => {}, info: () => {}, warn: (m) => console.error('[warn]', m), error: (m) => console.error('[error]', m) };

function findFileEvent(events: readonly BCEvent[]): FileDownloadReadyEvent | undefined {
  return events.find((e): e is FileDownloadReadyEvent => e.type === 'FileDownloadReady');
}

async function runReportOnce(auth: NTLMAuthProvider): Promise<FileDownloadReadyEvent | undefined> {
  const cfg = loadConfig();
  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const sf = new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString, cfg.bc.applicationId), quiet, cfg.bc.tenantId, cfg.bc.invokeTimeoutMs);
  const sessRes = await sf.create();
  if (isErr(sessRes)) { console.error('SESSION FAILED:', sessRes.error.message); return undefined; }
  const session = unwrap(sessRes);

  const result = await session.runReportWithDownload(6, 'pdf');
  if (isErr(result)) { console.error('RUNREPORT FAILED:', result.error.message); await session.close(); return undefined; }
  const { events } = unwrap(result);
  console.error(`  events: ${events.map(e => e.type).join(', ')}`);
  const fileEvent = findFileEvent(events);
  await session.close();
  return fileEvent;
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  console.error('=== TEST A: SAME auth for WS + download GET ===');
  const authA = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  unwrap(await authA.authenticate());
  const fileA = await runReportOnce(authA);
  if (fileA) {
    const httpA = new BCHttpClient(cfg.bc.baseUrl, () => authA.getWebSocketHeaders(), quiet);
    try {
      const payload = await httpA.get(fileA.relativeUrl, { maxBytes: cfg.bc.downloadLimits.maxBytes });
      console.error(`  TEST A RESULT: SUCCESS, ${payload.bytes.byteLength} bytes, contentType=${payload.contentType}`);
    } catch (e) {
      console.error(`  TEST A RESULT: FAILED - ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.error('  TEST A: no file event found');
  }

  console.error('\n=== TEST B: SEPARATE auth for WS vs download GET (mirrors current tests) ===');
  const authB1 = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
  unwrap(await authB1.authenticate());
  const fileB = await runReportOnce(authB1);
  if (fileB) {
    const authB2 = new NTLMAuthProvider({ baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId }, quiet);
    unwrap(await authB2.authenticate());
    const httpB = new BCHttpClient(cfg.bc.baseUrl, () => authB2.getWebSocketHeaders(), quiet);
    try {
      const payload = await httpB.get(fileB.relativeUrl, { maxBytes: cfg.bc.downloadLimits.maxBytes });
      console.error(`  TEST B RESULT: SUCCESS, ${payload.bytes.byteLength} bytes, contentType=${payload.contentType}`);
    } catch (e) {
      console.error(`  TEST B RESULT: FAILED - ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.error('  TEST B: no file event found');
  }

  process.exit(0);
}

main().catch((e) => { console.error('CRASHED:', e); process.exit(1); });
