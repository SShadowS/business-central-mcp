import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import type { Operations } from '../mcp/tool-registry.js';
import type { Logger } from '../core/logger.js';
import { BCError } from '../core/errors.js';
import { bcErrorToHttp } from './middleware.js';
import { invalidOperationId, isAmbiguousFailure, type IdempotencyGate } from '../mcp/idempotency-gate.js';
import {
  OpenPageSchema,
  ReadDataSchema,
  WriteDataSchema,
  ExecuteActionSchema,
  ClosePageSchema,
  SearchPagesSchema,
  NavigateSchema,
} from '../mcp/schemas.js';

type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;
type Op = { execute(input: never): Promise<unknown> };

/**
 * REST routes. Mutating routes run through the same replay gate as their MCP
 * tool (named by `tool`), keyed by the `Idempotency-Key` header, so one key
 * means one operation on both transports. Without a gate (or a key) they run
 * ungated.
 */
export function createApiRoutes(ops: Operations, logger: Logger, gate?: IdempotencyGate): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>();

  const route = (path: string, schema: z.ZodType, op: Op, tool?: string): void => {
    routes.set(`POST /api/v1/${path}`, async (req, res, body) => {
      const mutating = tool !== undefined;
      const key = mutating && gate ? req.headers?.['idempotency-key'] : undefined;
      const badKey = key === undefined ? undefined : invalidOperationId(key);
      if (badKey) return send(res, 400, { error: `Idempotency-Key ${badKey}`, code: 'VALIDATION_ERROR' });
      const parsed = schema.safeParse(body);
      if (!parsed.success) return send(res, 400, { error: parsed.error.message, code: 'VALIDATION_ERROR' });
      const exec = () => runOp(op, parsed.data);

      if (key === undefined) return sendRun(res, await exec(), mutating);
      const gated = await gate!.run(tool!, key as string, parsed.data, exec);
      switch (gated.kind) {
        case 'ran': return sendRun(res, gated.outcome, true);
        case 'replayed':
          logger.info(`REST ${path}: replayed Idempotency-Key result`);
          return send(res, 200, gated.value, { 'Idempotent-Replayed': 'true' });
        case 'reused': return send(res, 422, { error: gated.message, code: 'OPERATION_ID_REUSED' });
        case 'inDoubt': return send(res, 409, { error: gated.message, ...gated.state });
      }
    });
  };

  route('pages/open', OpenPageSchema, ops.openPage);
  route('pages/read', ReadDataSchema, ops.readData);
  route('pages/write', WriteDataSchema, ops.writeData, 'bc_write_data');
  route('pages/action', ExecuteActionSchema, ops.executeAction, 'bc_execute_action');
  route('pages/close', ClosePageSchema, ops.closePage, 'bc_close_page');
  route('search', SearchPagesSchema, ops.searchPages);
  route('navigate', NavigateSchema, ops.navigate);

  return routes;
}

interface Run { value?: unknown; failure?: { code?: string; message: string }; error?: unknown }

/** Run an operation, folding a throw into a failure so the gate can classify it. */
async function runOp(op: Op, input: unknown): Promise<Run> {
  try {
    const r = await op.execute(input as never) as { ok: boolean; value?: unknown; error?: { code?: string; message?: string } };
    if (r.ok) return { value: r.value };
    return { failure: { code: r.error?.code, message: r.error?.message ?? 'Unknown error' }, error: r.error };
  } catch (e) {
    return { failure: { code: e instanceof BCError ? e.code : undefined, message: e instanceof Error ? e.message : String(e) }, error: e };
  }
}

/**
 * Success -> 200 with the value. Failure -> 401 (sign-in), 504 (timeout),
 * 503 (other ambiguous: session lost, transport, protocol, aborted), 500
 * (untyped), else 400 (BC gave a definite answer). Ambiguous failures of a
 * mutating route carry replaySafe:false: the change may have committed.
 */
function sendRun(res: ServerResponse, run: Run, mutating: boolean): void {
  if (!run.failure) return send(res, 200, run.value);
  const { code, message } = run.failure;
  const body = run.error instanceof BCError ? bcErrorToHttp(run.error).body : { error: message, ...(code ? { code } : {}) };
  const ambiguous = isAmbiguousFailure(code);
  if (mutating && ambiguous) body['replaySafe'] = false;
  const status = run.error instanceof BCError && run.error.authRequired ? 401
    : code === 'TIMEOUT_ERROR' ? 504
    : code === undefined ? 500
    : ambiguous ? 503
    : 400;
  send(res, status, body);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
