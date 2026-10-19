// Issue #43: bc_run_tests drives page 130455 "Command Line Test Tool".
// JSON payloads are TestResultsToJSON output captured live on cronus28.
import { describe, it, expect, vi } from 'vitest';
import { RunTestsOperation, rowsFromCodeunitJson } from '../../src/operations/run-tests.js';
import { buildFormTree } from '../../src/protocol/form-tree-builder.js';
import { fields } from '../../src/protocol/form-views.js';
import { ok, err } from '../../src/core/result.js';
import { ProtocolError, TimeoutError } from '../../src/core/errors.js';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const CU_PASS = { name: 'I49 Restrictive Tests', codeUnit: 50490, codeunitName: 'I49 Restrictive Tests', result: 2, testResults: [
  { method: 'MockIsStartedByRunner', startTime: '2026-10-19T16:49:20.7730000Z', finishTime: '2026-10-19T16:49:20.7870000Z', result: 2 },
  { method: 'NoPersonaReadsCustomer', startTime: '2026-10-19T16:49:20.7970000Z', finishTime: '2026-10-19T16:49:20.8070000Z', result: 2 },
] };
const CU_FAIL = { name: 'I49 SelfStart Tests', codeUnit: 50491, codeunitName: 'I49 SelfStart Tests', result: 1, testResults: [
  { method: 'MockStoppedAfterSelfStart', startTime: '2026-10-19T16:49:21.0470000Z', finishTime: '2026-10-19T16:49:21.0500000Z', result: 1,
    message: 'Assert.IsFalse failed. Permissions Mock leaked as started', stackTrace: 'Library Assert(CodeUnit 130002).IsFalse line 3' },
] };

function harness(opts: { caption?: string; openError?: ProtocolError; runs: unknown[] }) {
  const root = buildFormTree({ t: 'lf', ServerId: 'F', Caption: opts.caption ?? 'Command Line Test Tool', Children: [{ t: 'sc', Caption: 'Test Result JSON', StringValue: '' }] });
  const jsonField = fields(root).find((f) => f.properties.caption === 'Test Result JSON')!;
  const repo = { get: () => ({ rootFormId: 'F', forms: new Map([['F', { root }]]) }) };
  const pages = {
    openPage: vi.fn().mockResolvedValue(opts.openError ? err(opts.openError) : ok({ pageContextId: 'pc', caption: opts.caption ?? 'Command Line Test Tool' })),
    closePage: vi.fn().mockResolvedValue(ok({})),
  };
  const data = { writeField: vi.fn().mockResolvedValue(ok({ success: true })) };
  const queue = [...opts.runs];
  const actions = {
    executeAction: vi.fn().mockImplementation(async () => {
      const next = queue.shift() ?? 'All tests executed.';
      if (next instanceof Error) return err(next);
      (jsonField.properties as { stringValue?: string }).stringValue = typeof next === 'string' ? next : JSON.stringify(next);
      return ok({ success: true, events: [] });
    }),
  };
  const op = new RunTestsOperation(pages as any, data as any, actions as any, repo as any, logger);
  return { op, pages, data, actions };
}

describe('rowsFromCodeunitJson', () => {
  it('maps results, durations and failures', () => {
    expect(rowsFromCodeunitJson(CU_FAIL)).toEqual([{
      codeunitId: 50491, codeunitName: 'I49 SelfStart Tests', method: 'MockStoppedAfterSelfStart', status: 'failed', durationMs: 3,
      output: 'Assert.IsFalse failed. Permissions Mock leaked as started', callStack: 'Library Assert(CodeUnit 130002).IsFalse line 3',
    }]);
  });

  it('turns a codeunit failure without method results into one row', () => {
    expect(rowsFromCodeunitJson({ codeUnit: 7, codeunitName: 'X', result: 1 })).toMatchObject([{ codeunitId: 7, method: '', status: 'failed' }]);
  });
});

describe('RunTestsOperation', () => {
  it('writes fields in page order, runs until all executed, and closes the page', async () => {
    const { op, data, actions, pages } = harness({ runs: [CU_PASS, CU_FAIL] });
    const res = await op.execute({ codeunits: '50490..50491', methods: '*Persona*' });
    expect(data.writeField.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['Suite Name', 'MCP'], ['Suite Name', 'MCP'], ['Test Runner Codeunit ID', '130450'],
      ['Test Codeunit Range', '50490..50491'], ['Test Procedure Range', '*Persona*'],
    ]);
    expect(actions.executeAction).toHaveBeenCalledTimes(3);
    expect(pages.closePage).toHaveBeenCalledWith('pc');
    expect(res.ok && res.value).toMatchObject({
      outcome: 'failed',
      summary: { total: 3, passed: 2, failed: 1 },
      failedTests: [{ codeunitId: 50491, method: 'MockStoppedAfterSelfStart' }],
      suiteName: 'MCP',
      replaySafe: false,
    });
  });

  it('sets isolation before test type, and only with a test type', async () => {
    const { op, data } = harness({ runs: [] });
    await op.execute({ extensionId: 'abc', requiredTestIsolation: 1, testType: 2 });
    expect(data.writeField.mock.calls.map((c) => c[1]).slice(3)).toEqual(['Extension ID', 'Required Test Isolation', 'Test Type']);
    const h2 = harness({ runs: [] });
    await h2.op.execute({ codeunits: '1', requiredTestIsolation: 1 });
    expect(h2.data.writeField.mock.calls.map((c) => c[1])).not.toContain('Required Test Isolation');
  });

  it('reports noTests when nothing matched', async () => {
    const res = await harness({ runs: [] }).op.execute({ codeunits: '99999' });
    expect(res.ok && res.value.outcome).toBe('noTests');
  });

  it('returns the finished codeunits when a later run fails', async () => {
    const { op, pages } = harness({ runs: [CU_PASS, new TimeoutError('watchdog')] });
    const res = await op.execute({ codeunits: '50490..50491' });
    expect(res.ok && res.value).toMatchObject({ outcome: 'aborted', summary: { total: 2 }, aborted: { code: 'TIMEOUT_ERROR' } });
    expect(pages.closePage).toHaveBeenCalled();
  });

  it('stops when the same codeunit comes back twice', async () => {
    const res = await harness({ runs: [CU_PASS, CU_PASS] }).op.execute({ codeunits: '50490' });
    expect(res.ok && res.value).toMatchObject({ outcome: 'aborted', summary: { total: 2 } });
  });

  it('maps a missing page or a foreign page 130455 to TEST_RUNNER_NOT_INSTALLED', async () => {
    const missing = await harness({ openError: new ProtocolError('JSON-RPC error: {"errorType":"Microsoft.Dynamics.Nav.Types.NavPageBuildErrorException","message":"Cannot build the page 130455. The metadata object Page 130455 was not found."}'), runs: [] }).op.execute({ codeunits: '1' });
    expect(!missing.ok && missing.error.code).toBe('TEST_RUNNER_NOT_INSTALLED');
    const foreign = await harness({ caption: 'Something Else', runs: [] }).op.execute({ codeunits: '1' });
    expect(!foreign.ok && foreign.error.code).toBe('TEST_RUNNER_NOT_INSTALLED');
    const lost = await harness({ openError: new TimeoutError('slow'), runs: [] }).op.execute({ codeunits: '1' });
    expect(!lost.ok && lost.error.code).toBe('TIMEOUT_ERROR');
  });
});
