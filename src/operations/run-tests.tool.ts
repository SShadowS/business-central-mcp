import { RunTestsSchema, RunTestsOutputSchema, toMcpJsonSchema } from '../mcp/schemas.js';
import type { ToolDefinition, Operations } from '../mcp/tool-registry.js';

export function createToolDefinition(ops: Operations): ToolDefinition {
  return {
    name: 'bc_run_tests',
    description: `Run AL test codeunits in Business Central through Microsoft's AL Test Runner (page 130455 "Command Line Test Tool", the same path BcContainerHelper uses) and return one structured row per test method. Runners 130450/130451 run the full before-test hook, so the Permissions Mock, TestPermissions and test personas apply; a dev-endpoint test hub does not, and restrictive tests can pass there as SUPER.

Select tests with exactly one of codeunits (a BC filter: "50490..50494", "50490|50492") or extensionId (app GUID). Narrow to methods with a name filter ("*Persona*"). The suite (default "MCP") is rebuilt on every call and stays in BC with the last run's results, so it does not touch BcContainerHelper's "DEFAULT" suite unless you name it.

The tool runs one codeunit per round trip until all are done. Each row has codeunitId, codeunitName, method, status (passed/failed/skipped/notRun), durationMs, output (the failure message) and callStack for failures, the same row shape as bc-dev-mcp's bcdev_test_run. outcome is "passed", "failed", "noTests" (the filter matched nothing) or "aborted" (the run stopped early, e.g. a test opened an unhandled dialog or the session dropped; results holds the codeunits that finished).

Use this to run, check or debug AL tests. It wraps the manual route (bc_open_page 130455, bc_write_data on "Suite Name" / "Test Codeunit Range", bc_execute_action "Run Next Test" until "All tests executed."); use those tools directly to inspect the suite's lines afterwards. Do NOT use it on production data with runner 130451 (isolation disabled): test writes are committed there. Returns TEST_RUNNER_NOT_INSTALLED when the Test Runner app is missing. Not idempotent: every call runs the tests again.

Example: { "codeunits": "50490..50494" }
Example: { "extensionId": "6c3f0b8e-4f49-4b49-9a49-0049c0de4949", "methods": "*Persona*" }
Example: { "codeunits": "134000", "testRunnerCodeunitId": 130451, "suiteName": "NOISOL" }`,
    inputSchema: toMcpJsonSchema(RunTestsSchema),
    outputSchema: toMcpJsonSchema(RunTestsOutputSchema),
    zodSchema: RunTestsSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    execute: (input) => ops.runTests.execute(input as Parameters<typeof ops.runTests.execute>[0]),
  };
}
