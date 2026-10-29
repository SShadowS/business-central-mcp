// tests/integration/data-query.test.ts
//
// bc_data_* against BC 29+'s native MCP server. Runs only when
// BC_MCP_TEST_URL points at a BC 29+ MCP endpoint with "Data Query Tools"
// enabled (e.g. http://cronus291:7048/BC/mcp); the default integration box
// (BC 28) has no such endpoint. Read-only: the tools never write.
//
// Verified 2026-10-29 on BC 29.1 (Cronus291), run inside the container: the
// host's NAT path to the BC containers stalls large HTTP/1.1 responses.

import { afterAll, describe, expect, it } from 'vitest';
import { BCMcpClient } from '../../src/bcmcp/bc-mcp-client.js';
import { DataQueryOperation } from '../../src/operations/data-query.js';
import { createNullLogger } from '../../src/core/logger.js';

const url = process.env.BC_MCP_TEST_URL;
const COMPANY = 'CRONUS Danmark A/S';

describe.runIf(url)('bc_data_* against BC 29+ native MCP', () => {
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
  const op = new DataQueryOperation(client, () => undefined, undefined);
  afterAll(() => client.close());

  it('finds the Customer table by keyword in the default company', async () => {
    const r = await op.findTables({ searchText: 'customer', searchMode: 'keyword', top: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.company).toBe(COMPANY);
    expect(r.value.tables).toContainEqual({ tableId: 18, tableName: 'Customer' });
  });

  it('reads the Customer schema and its outgoing relation to Country/Region', async () => {
    const schema = await op.getTableSchema({ tableId: 18, nameContains: ['No.'] });
    expect(schema.ok && schema.value.schema).toContain('Primary Key: No.');
    const rel = await op.getTableRelations({ tableId: 18, direction: 'outgoing', relatedToTableIds: [9] });
    expect(rel.ok && rel.value.outgoing).toEqual([
      { targetTableId: 9, targetTableName: 'Country/Region', viaFields: [{ fieldNo: 35, fieldName: 'Country/Region Code' }] },
    ]);
  });

  it('compiles, runs and pages an aggregating query', async () => {
    const queryText = 'query 50110 CustBalance { elements { dataitem(CLE; "Cust. Ledger Entry") { column(CustomerNo; "Customer No.") { } column(Amount; Amount) { Method = Sum; } } } }';
    const compiled = await op.query({ queryText });
    expect(compiled.ok && compiled.value.status).toBe('compiled');

    const first = await op.query({ queryText, returnData: true, top: 3 });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.status !== 'executed') return;
    expect(first.value.columns).toEqual(['CustomerNo', 'Amount']);
    expect(first.value.rowCount).toBe(3);
    expect(first.value.totalCount).toBeGreaterThan(3);
    expect(first.value.hasMore).toBe(true);

    const second = await op.query({ queryText, returnData: true, top: 3, skip: 3 });
    expect(second.ok && second.value.status === 'executed' && second.value.rows[0]?.[0]).not.toBe(first.value.rows[0]?.[0]);
  });

  it('returns BC\'s AL diagnostics for a query that does not compile', async () => {
    const r = await op.query({ queryText: 'query 50111 Bad { elements { dataitem(C; Customer) { column(Nope; Nope) { } } } }' });
    expect(!r.ok && r.error.code).toBe('DATA_QUERY_ERROR');
    expect(!r.ok && r.error.message).toContain('AL0345');
  });

  it('runs in an explicitly named company', async () => {
    const queryText = 'query 50113 CustCount { elements { dataitem(C; Customer) { column(Cnt) { Method = Count; } } } }';
    const r = await op.query({ queryText, returnData: true, company: 'My Company' });
    expect(r.ok && r.value.company).toBe('My Company');
    expect(r.ok && r.value.status === 'executed' && r.value.rows).toEqual([[0]]);
  });
});
