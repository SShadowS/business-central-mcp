// tests/integration/api-actions-destructive.test.ts
//
// bc_api_invoke write flow against BC 29+: create a customer, modify it, delete
// it. Touches only the record it creates. Runs only when BC_MCP_TEST_URL points
// at a BC 29+ MCP endpoint whose MCP configuration grants Create/Modify/Delete
// on the customers API page 30009 (Cronus291: a row in "MCP Configuration Tool").

import { afterAll, describe, expect, it } from 'vitest';
import { BCMcpClient } from '../../src/bcmcp/bc-mcp-client.js';
import { BCMcpToolRunner } from '../../src/bcmcp/bc-mcp-tools.js';
import { ApiActionsOperation } from '../../src/operations/api-actions.js';
import { ApiActionError } from '../../src/core/errors.js';
import { createNullLogger } from '../../src/core/logger.js';

const url = process.env.BC_MCP_TEST_URL;

describe.runIf(url)('bc_api_invoke create -> modify -> delete (destructive tier)', () => {
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
  let createdId: string | undefined;
  afterAll(async () => {
    // Remove the test customer even when an assertion failed half-way.
    if (createdId) await op.invoke({ actionName: 'Delete_Customer_PAG30009', parameters: { id: createdId } });
    await client.close();
  });

  it('creates, modifies (refusing a stale etag) and deletes a customer it owns', async () => {
    const created = await op.invoke({ actionName: 'Create_Customer_PAG30009', parameters: { displayName: 'bc-mcp integration customer' } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.replaySafe).toBe(false);
    const record = created.value.result as { id: string; '@odata.etag': string };
    createdId = record.id;

    const modified = await op.invoke({ actionName: 'Modify_Customer_PAG30009', parameters: { id: record.id, 'If-Match': record['@odata.etag'], city: 'Odense' } });
    expect(modified.ok && modified.value.replaySafe).toBe(true);
    expect(modified.ok && (modified.value.result as { city: string }).city).toBe('Odense');

    const stale = await op.invoke({ actionName: 'Modify_Customer_PAG30009', parameters: { id: record.id, 'If-Match': record['@odata.etag'], city: 'Vejle' } });
    expect(!stale.ok && (stale.error as ApiActionError).odataCode).toBe('Request_EntityChanged');

    const deleted = await op.invoke({ actionName: 'Delete_Customer_PAG30009', parameters: { id: record.id } });
    expect(deleted).toEqual({ ok: true, value: expect.objectContaining({ result: undefined, replaySafe: true }) });
    createdId = undefined;

    const again = await op.invoke({ actionName: 'Delete_Customer_PAG30009', parameters: { id: record.id } });
    expect(!again.ok && (again.error as ApiActionError).odataCode).toBe('BadRequest_ResourceNotFound');
  });
});
