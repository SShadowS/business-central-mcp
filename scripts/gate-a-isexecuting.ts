/**
 * Gate A probe — spec docs/superpowers/specs/2026-07-24-long-running-ops-design.md
 *
 * Question: can the /csh WebSocket answer an `IsExecuting` interaction sent
 * WHILE another Invoke is still outstanding?
 *
 * Method: start a slow Invoke without awaiting it, then push raw JSON-RPC
 * `Invoke` frames whose single interaction is named "IsExecuting" straight onto
 * the socket, bypassing BCWebSocket.enqueueSend (which otherwise serialises an
 * RPC through its response). Every inbound frame is timestamped, so the run also
 * yields partial Gate B data (inter-frame gaps during a long operation).
 *
 * Reference: CallbackHandler.IsIsExecutingRequest (:231-247) matches on
 * InteractionName == "IsExecuting" and answers from HasEnteredProcessing BEFORE
 * EnterProcessing (:97-104), returning DN.IsExecutingHandler (:267-276).
 *
 * Run: npx tsx scripts/gate-a-isexecuting.ts
 */
import { v4 as uuid } from 'uuid';
import { loadConfig } from '../src/core/config.js';
import { NTLMAuthProvider } from '../src/connection/auth/ntlm-provider.js';
import { ConnectionFactory } from '../src/connection/connection-factory.js';
import { EventDecoder } from '../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../src/protocol/interaction-encoder.js';
import { SessionFactory } from '../src/session/session-factory.js';
import { decompressPayload, decompressIfNeeded } from '../src/protocol/decompression.js';
import { isErr, isOk, unwrap } from '../src/core/result.js';
import type { Logger } from '../src/core/logger.js';
import type { OpenFormInteraction } from '../src/protocol/types.js';

const quiet: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg: string) => console.error('[warn]', msg),
  error: (msg: string) => console.error('[error]', msg),
};

const T0 = Date.now();
const ms = () => String(Date.now() - T0).padStart(6, ' ');

interface FrameLog { at: number; id?: string; method?: string; handlers: string[]; bytes: number; }
const frames: FrameLog[] = [];
const rawDump: Array<{ id: string; keys: string[]; result: unknown; error: unknown }> = [];

/** Decompress a whole frame (handles compressedResult / compressedData / plain). */
function bodyOf(frame: Record<string, unknown>): unknown {
  const d = decompressIfNeeded(frame);
  return isOk(d) ? d.value : (frame['result'] ?? frame['params']);
}

/** Pull handler-type strings out of a response payload, decompressing if needed. */
function handlerTypes(value: unknown): string[] {
  let v = value;
  if (v && typeof v === 'object' && 'compressedData' in (v as Record<string, unknown>)) {
    const d = decompressPayload((v as Record<string, string>)['compressedData']!);
    if (isOk(d)) v = d.value;
  }
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      if (typeof o['HandlerType'] === 'string') out.push(o['HandlerType']);
      if (typeof o['handlerType'] === 'string') out.push(o['handlerType'] as string);
      Object.values(o).forEach(walk);
    }
  };
  walk(v);
  return out;
}

/** Extract the IsExecuting answer ("true"/"false") if this frame is one. */
function isExecutingAnswer(value: unknown): string | undefined {
  let v = value;
  if (v && typeof v === 'object' && 'compressedData' in (v as Record<string, unknown>)) {
    const d = decompressPayload((v as Record<string, string>)['compressedData']!);
    if (isOk(d)) v = d.value;
  }
  let answer: string | undefined;
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      const ht = (o['HandlerType'] ?? o['handlerType']) as string | undefined;
      if (ht === 'DN.IsExecutingHandler') {
        const params = (o['Parameters'] ?? o['parameters']) as unknown[] | undefined;
        if (Array.isArray(params) && params.length > 0) answer = String(params[0]);
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(v);
  return answer;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`Gate A probe against ${cfg.bc.baseUrl} (tenant ${cfg.bc.tenantId}, user ${cfg.bc.username})`);

  const auth = new NTLMAuthProvider(
    { baseUrl: cfg.bc.baseUrl, username: cfg.bc.username, password: cfg.bc.password, tenantId: cfg.bc.tenantId },
    quiet,
  );
  const authResult = await auth.authenticate();
  if (isErr(authResult)) { console.error('AUTH FAILED:', authResult.error.message); process.exit(1); }

  const conn = new ConnectionFactory(auth, cfg.bc, quiet);
  const sf = new SessionFactory(conn, new EventDecoder(), new InteractionEncoder(cfg.bc.clientVersionString), quiet, cfg.bc.tenantId);
  const sessRes = await sf.create();
  if (isErr(sessRes)) { console.error('SESSION FAILED:', sessRes.error.message); process.exit(1); }
  const session = unwrap(sessRes);

  // Reach past the public API deliberately: this probe exists to test what the
  // public API forbids (a second in-flight request on the same socket).
  const priv = session as unknown as {
    ws: {
      onMessage: (h: (raw: unknown) => void) => () => void;
      spaInstanceId: string;
      nextSequenceNo: string;
      lastClientAckSequenceNumber: number;
      ws: { send: (data: string) => void };
    };
    sessionId: string; sessionKey: string; company: string; tenantId: string;
  };
  const ws = priv.ws;
  console.log(`Session up. company="${priv.company}" sessionId=${priv.sessionId.slice(0, 12)}…`);

  const probeIds = new Map<string, number>();   // raw id -> sent-at
  const probeAnswers: Array<{ id: string; at: number; rtt: number; answer?: string }> = [];
  let invokeResponseAt = 0;

  ws.onMessage((raw: unknown) => {
    const at = Date.now() - T0;
    const r = (raw ?? {}) as Record<string, unknown>;
    const bytes = JSON.stringify(raw).length;
    const id = typeof r['id'] === 'string' ? r['id'] : undefined;
    const body = bodyOf(r);
    const hts = handlerTypes(body);
    frames.push({ at, id, method: r['method'] as string | undefined, handlers: hts, bytes });

    if (id && probeIds.has(id)) {
      const sentAt = probeIds.get(id)!;
      const answer = isExecutingAnswer(body);
      probeAnswers.push({ id, at, rtt: at - sentAt, answer });
      console.log(`${ms()} <- PROBE RESPONSE id=${id.slice(0, 8)} rtt=${at - sentAt}ms answer=${answer ?? '(none)'} handlers=[${hts.join(',')}]`);
      rawDump.push({ id: id.slice(0, 8), keys: Object.keys(r), result: body, error: r['error'] });
    } else {
      console.log(`${ms()} <- frame ${id ? 'id=' + id.slice(0, 8) : 'method=' + String(r['method'])} bytes=${bytes} handlers=[${hts.slice(0, 4).join(',')}]`);
    }
  });

  /** Raw IsExecuting frame, bypassing enqueueSend entirely. */
  const sendProbe = (): string => {
    const id = uuid();
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'Invoke',
      params: [{
        sessionId: priv.sessionId,
        sessionKey: priv.sessionKey,
        company: priv.company,
        tenantId: priv.tenantId,
        openFormIds: Array.from(session.openFormIds),
        interactionsToInvoke: [{
          interactionName: 'IsExecuting',
          namedParameters: JSON.stringify({ SuppressInvalidSession: true }),
          callbackId: uuid(),
        }],
        sequenceNo: ws.nextSequenceNo,
        lastClientAckSequenceNumber: ws.lastClientAckSequenceNumber,
        navigationContext: { applicationId: 'FIN', deviceCategory: 0, spaInstanceId: ws.spaInstanceId },
        features: [],
        supportedExtensions: '[]',
        telemetryClientActivityId: null,
        telemetryClientSessionId: null,
      }],
    });
    probeIds.set(id, Date.now() - T0);
    ws.ws.send(payload);
    console.log(`${ms()} -> PROBE  id=${id.slice(0, 8)} (IsExecuting, out of band)`);
    return id;
  };

  // ---- Experiment: slow Invoke in flight, probes fired underneath it --------
  const pageId = Number(process.env['GATE_A_PAGE'] ?? 20);   // 20 = G/L Entries (large on CRONUS)
  console.log(`\n--- starting slow Invoke: OpenForm page=${pageId} (not awaited) ---`);

  const open: OpenFormInteraction = { type: 'OpenForm', query: `page=${pageId}&tenant=${priv.tenantId}` };
  const started = Date.now() - T0;
  const invokePromise = session.invoke(open, (e) => e.type === 'InvokeCompleted' || e.type === 'FormCreated')
    .then((r) => { invokeResponseAt = Date.now() - T0; return r; });

  // Fire probes underneath the in-flight invoke.
  const PROBE_COUNT = Number(process.env['GATE_A_PROBES'] ?? 6);
  const PROBE_GAP_MS = Number(process.env['GATE_A_GAP'] ?? 250);
  for (let i = 0; i < PROBE_COUNT; i++) {
    await new Promise((r) => setTimeout(r, PROBE_GAP_MS));
    if (invokeResponseAt) { console.log(`${ms()} (invoke already answered — stopping probes)`); break; }
    sendProbe();
  }

  const result = await invokePromise;
  await new Promise((r) => setTimeout(r, 1000));   // let trailing frames land

  // ---- Verdict -------------------------------------------------------------
  const concurrent = probeAnswers.filter((p) => invokeResponseAt === 0 || p.at < invokeResponseAt);
  const gaps: number[] = [];
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i]!.at - frames[i - 1]!.at);

  console.log('\n================ GATE A RESULT ================');
  console.log(`Invoke started at   ${started}ms, answered at ${invokeResponseAt || '(never)'}ms  -> ${isOk(result) ? 'ok' : 'ERR: ' + result.error.message}`);
  console.log(`Probes sent         ${probeIds.size}`);
  console.log(`Probe responses     ${probeAnswers.length}`);
  console.log(`  …before invoke    ${concurrent.length}   <-- THE ANSWER: >0 means /csh answers IsExecuting concurrently`);
  if (probeAnswers.length) {
    console.log(`  answers           ${probeAnswers.map((p) => `${p.answer ?? '?'}@${p.at}ms(rtt ${p.rtt}ms)`).join(', ')}`);
  }
  console.log(`Session still alive ${session.isAlive}`);
  console.log(`\nFrames observed     ${frames.length}`);
  console.log(`Max inter-frame gap ${gaps.length ? Math.max(...gaps) : 0}ms   (partial Gate B signal)`);

  // Did the probes corrupt the session? Follow-up invoke on the same socket.
  console.log('\n--- post-probe sanity invoke (does the session still work?) ---');
  const after = await session.invoke({ type: 'OpenForm', query: `page=22&tenant=${priv.tenantId}` }, (e) => e.type === 'InvokeCompleted' || e.type === 'FormCreated');
  console.log(`Follow-up invoke:   ${isOk(after) ? 'ok — sequence not corrupted' : 'ERR: ' + after.error.message}`);

  const fs = await import('node:fs');
  fs.writeFileSync('scripts/gate-a-rawdump.json', JSON.stringify(rawDump, null, 2));
  console.log(`\nWrote ${rawDump.length} raw probe responses to scripts/gate-a-rawdump.json`);

  await session.close();
  process.exit(0);
}

main().catch((e) => { console.error('PROBE CRASHED:', e); process.exit(1); });
