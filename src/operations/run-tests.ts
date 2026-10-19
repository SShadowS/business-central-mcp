import { ok, err, isErr, type Result } from '../core/result.js';
import { ProtocolError, TestRunnerNotInstalledError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { PageContextRepository } from '../protocol/page-context-repo.js';
import { fields as treeFields } from '../protocol/form-views.js';
import type { PageService } from '../services/page-service.js';
import type { DataService } from '../services/data-service.js';
import type { ActionService } from '../services/action-service.js';

/**
 * bc_run_tests (issue #43): run AL tests through Microsoft's Test Runner app,
 * page 130455 "Command Line Test Tool", the page BcContainerHelper drives. Unlike
 * the dev endpoint's TestRunnerHub, its runners (130450/130451) start the
 * Permissions Mock and the rest of the before-test hook.
 *
 * Page semantics (Test Runner app source, CommandLineTestTool.Page.al +
 * TestSuiteMgt.Codeunit.al): every selection field's OnValidate deletes the
 * suite's lines and reselects, so fields are written in a fixed order. Each
 * "Run Next Test" runs the next codeunit whose Result is blank and puts its
 * result JSON in "Test Result JSON", or 'All tests executed.' when none is left.
 */

const TEST_TOOL_PAGE = '130455';
const TEST_TOOL_CAPTION = 'Command Line Test Tool';
const ALL_EXECUTED = 'All tests executed.';
const DEFAULT_SUITE = 'MCP';
const DEFAULT_RUNNER = 130450;

export interface RunTestsInput {
  codeunits?: string;
  extensionId?: string;
  methods?: string;
  suiteName?: string;
  testRunnerCodeunitId?: number;
  requiredTestIsolation?: number;
  testType?: number;
}

export type TestStatus = 'passed' | 'failed' | 'skipped' | 'notRun';

export interface TestResultRow {
  codeunitId: number;
  codeunitName: string;
  /** '' for a codeunit-level failure that produced no method results. */
  method: string;
  status: TestStatus;
  durationMs: number;
  /** Failure message ('' otherwise). Same field name as bc-dev-mcp's bcdev_test_run row. */
  output: string;
  callStack?: string;
}

export interface RunTestsOutput {
  outcome: 'passed' | 'failed' | 'noTests' | 'aborted';
  summary: { total: number; passed: number; failed: number; skipped: number; notRun: number; durationMs: number };
  results: TestResultRow[];
  failedTests: Array<{ codeunitId: number; method: string }>;
  /** The suite stays in BC with this run's lines and results; the next run with this name replaces them. */
  suiteName: string;
  testRunnerCodeunitId: number;
  /** Set when the run stopped early; `results` holds the codeunits that finished. */
  aborted?: { code: string; message: string };
  /** Always false: re-running runs the tests again (runner 130451 commits their writes). */
  replaySafe: false;
}

/** Test Method Line.Result option: " ",Failure,Success,Skipped (TestMethodLine.Table.al). */
const STATUS: Record<number, TestStatus> = { 0: 'notRun', 1: 'failed', 2: 'passed', 3: 'skipped' };

interface CodeunitJson {
  name?: string;
  codeUnit: number;
  codeunitName?: string;
  result: number;
  testResults?: Array<{ method: string; startTime?: string; finishTime?: string; result: number; message?: string; stackTrace?: string }>;
}

const durationMs = (start?: string, finish?: string): number => {
  const ms = Date.parse(finish ?? '') - Date.parse(start ?? '');
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
};

/** Rows for one codeunit's TestResultsToJSON payload. */
export function rowsFromCodeunitJson(json: CodeunitJson): TestResultRow[] {
  const codeunitName = json.codeunitName ?? json.name ?? '';
  const methods = json.testResults ?? [];
  if (methods.length === 0) {
    // A codeunit that failed before any method ran (e.g. OnRun/initialisation error).
    return json.result === 1
      ? [{ codeunitId: json.codeUnit, codeunitName, method: '', status: 'failed', durationMs: 0, output: 'The codeunit failed without method results.' }]
      : [];
  }
  return methods.map((m) => ({
    codeunitId: json.codeUnit,
    codeunitName,
    method: m.method,
    status: STATUS[m.result] ?? 'failed',
    durationMs: durationMs(m.startTime, m.finishTime),
    output: m.message ?? '',
    ...(m.stackTrace ? { callStack: m.stackTrace } : {}),
  }));
}

export function summarize(results: TestResultRow[], aborted: boolean): Pick<RunTestsOutput, 'outcome' | 'summary' | 'failedTests'> {
  const count = (s: TestStatus) => results.filter((r) => r.status === s).length;
  const summary = {
    total: results.length,
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    notRun: count('notRun'),
    durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
  };
  const outcome = aborted ? 'aborted' : summary.failed > 0 ? 'failed' : summary.total === 0 ? 'noTests' : 'passed';
  return {
    outcome,
    summary,
    failedTests: results.filter((r) => r.status === 'failed').map((r) => ({ codeunitId: r.codeunitId, method: r.method })),
  };
}

export class RunTestsOperation {
  constructor(
    private readonly pages: PageService,
    private readonly data: DataService,
    private readonly actions: ActionService,
    private readonly repo: PageContextRepository,
    private readonly logger: Logger,
  ) {}

  async execute(input: RunTestsInput): Promise<Result<RunTestsOutput, ProtocolError>> {
    const suiteName = (input.suiteName ?? DEFAULT_SUITE).toUpperCase();
    const runner = input.testRunnerCodeunitId ?? DEFAULT_RUNNER;

    const opened = await this.pages.openPage(TEST_TOOL_PAGE);
    if (isErr(opened)) {
      // BC answers an unknown page with a "does not exist" error; anything else
      // (session loss, timeout) passes through unchanged.
      return /exist|not found/i.test(opened.error.message)
        ? err(new TestRunnerNotInstalledError(`Page ${TEST_TOOL_PAGE} "${TEST_TOOL_CAPTION}" is not available: ${opened.error.message}`))
        : opened;
    }
    const pcId = opened.value.pageContextId;
    if (opened.value.caption !== TEST_TOOL_CAPTION) {
      await this.pages.closePage(pcId);
      return err(new TestRunnerNotInstalledError(`Page ${TEST_TOOL_PAGE} is "${opened.value.caption}", not "${TEST_TOOL_CAPTION}" (Microsoft's Test Runner app).`));
    }

    try {
      // Order matters, each selection field reselects the suite's lines:
      // Suite Name twice (a NEW suite is created on the first validate, but the
      // page keeps its global record unloaded, so selections would land in a
      // nameless suite; the second validate loads it; verified live cronus28),
      // then runner, extension, isolation + type (type reselects by
      // extension + categorization), codeunit range (reselects by range,
      // filtered by type), and last the method filter (only flips Run flags).
      const writes: Array<[string, string | number | undefined]> = [
        ['Suite Name', suiteName],
        ['Suite Name', suiteName],
        ['Test Runner Codeunit ID', runner],
        ['Extension ID', input.extensionId],
        ['Required Test Isolation', input.testType !== undefined ? input.requiredTestIsolation : undefined],
        ['Test Type', input.testType],
        ['Test Codeunit Range', input.codeunits],
        ['Test Procedure Range', input.methods],
      ];
      for (const [field, value] of writes) {
        if (value === undefined) continue;
        const w = await this.data.writeField(pcId, field, String(value));
        if (isErr(w)) return w;
        if (!w.value.success) return err(new ProtocolError(`Setting "${field}" to "${value}" failed: ${w.value.error ?? 'BC rejected the value'}`));
      }

      const results: TestResultRow[] = [];
      let aborted: RunTestsOutput['aborted'];
      const seen = new Set<number>();
      for (;;) {
        const run = await this.actions.executeAction(pcId, 'Run Next Test');
        if (isErr(run)) {
          aborted = { code: run.error.code, message: run.error.message };
          break;
        }
        if (run.value.events.some((e) => e.type === 'DialogOpened')) {
          aborted = { code: 'DIALOG_OPENED', message: 'A test run opened a dialog the test did not handle; the run stopped. Results so far are returned.' };
          break;
        }
        const json = this.resultJson(pcId);
        if (json === ALL_EXECUTED) break;
        let parsed: CodeunitJson;
        try {
          parsed = JSON.parse(json ?? '') as CodeunitJson;
        } catch {
          aborted = { code: 'PROTOCOL_ERROR', message: `"Test Result JSON" did not hold a result: ${JSON.stringify(json)?.slice(0, 200)}` };
          break;
        }
        if (seen.has(parsed.codeUnit)) {
          // RunNextTest picks the next codeunit line whose Result is blank; the
          // same one twice means its result never got set, and it would loop.
          aborted = { code: 'PROTOCOL_ERROR', message: `Codeunit ${parsed.codeUnit} was run twice; its result is not being recorded. The run stopped.` };
          break;
        }
        seen.add(parsed.codeUnit);
        const rows = rowsFromCodeunitJson(parsed);
        results.push(...rows);
        this.logger.info(`bc_run_tests: codeunit ${parsed.codeUnit} ${parsed.codeunitName ?? ''} done (${rows.length} tests, ${results.length} so far)`);
      }

      return ok({ ...summarize(results, aborted !== undefined), results, suiteName, testRunnerCodeunitId: runner, ...(aborted ? { aborted } : {}), replaySafe: false });
    } finally {
      // Header fields are page variables, nothing to save; close quietly.
      await this.pages.closePage(pcId).catch(() => undefined);
    }
  }

  private resultJson(pcId: string): string | undefined {
    const ctx = this.repo.get(pcId);
    const root = ctx?.forms.get(ctx.rootFormId)?.root;
    const field = root && treeFields(root).find((f) => f.properties.caption === 'Test Result JSON');
    return field?.properties.stringValue;
  }
}
