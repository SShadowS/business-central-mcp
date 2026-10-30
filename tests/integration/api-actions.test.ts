// tests/integration/api-actions.test.ts
//
// bc_api_* reads against BC 29+'s native MCP API tools. Runs only when
// BC_MCP_TEST_URL points at a BC 29+ MCP endpoint (e.g.
// http://cronus291:7048/BC/mcp). Read-only; the write flow lives in
// api-actions-destructive.test.ts.

import { afterAll, describe, expect, it } from 'vitest';
import { BCMcpClient } from '../../src/bcmcp/bc-mcp-client.js';
import { BCMcpToolRunner } from '../../src/bcmcp/bc-mcp-tools.js';
import { ApiActionsOperation } from '../../src/operations/api-actions.js';
import { createNullLogger } from '../../src/core/logger.js';

const url = process.env.BC_MCP_TEST_URL;

describe.runIf(url)('bc_api_* reads against BC 29+ native MCP', () => {
  const client = new BCMcpClient({
    mcpUrl: url!,
    tenantId: process.env.BC_TENANT_ID ?? 'default',
    appendTenantQuery: true,
    username: process.env.BC_USERNAME ?? 'sshadows',
    password: process.env.BC_PASSWORD ?? '1234',
    requireBearer: false,
    requestTimeoutMs: 60_000,
    logger: createNullLogger(),
  });
  const op = new ApiActionsOperation(new BCMcpToolRunner(client, () => undefined, undefined));
  afterAll(() => client.close());

  it('finds the customers List action', async () => {
    const r = await op.search({ searchText: 'customer', actionTypes: ['List'], top: 50 });
    expect(r.ok && r.value.actions).toContain('List_Customers_PAG30009');
  });

  it('describes the List action with its available fields', async () => {
    const r = await op.describe({ actionName: 'List_Customers_PAG30009' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const props = r.value.schema.properties as Record<string, { description?: string }>;
    expect(props._availableFields?.description).toContain('displayName');
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['filter', 'select', 'top', 'skip']));
  });

  it('lists customers with filter, select and paging', async () => {
    const first = await op.list({ actionName: 'List_Customers_PAG30009', select: 'number,displayName', orderby: 'number', top: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.rowCount).toBe(2);
    expect(first.value.hasMore).toBe(true);
    const filtered = await op.list({ actionName: 'List_Customers_PAG30009', filter: "number eq '10000'", select: 'number' });
    expect(filtered.ok && filtered.value.rows).toEqual([expect.objectContaining({ number: '10000' })]);
  });

  it('reports BC\'s rejection of an unsupported option as API_ACTION_ERROR', async () => {
    // This API query does not allow orderby (live BC 29.1).
    const r = await op.list({ actionName: 'List_CustomerLedgerEntries_QRY30302', orderby: 'amount desc', top: 1 });
    expect(!r.ok && r.error.code).toBe('API_ACTION_ERROR');
  });
});
