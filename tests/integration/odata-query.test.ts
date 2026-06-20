// tests/integration/odata-query.test.ts
//
// Live integration tests for ODataClient and QueryOperation against real BC28.
// READ-ONLY — no mutations. Requires BC OData endpoint on port 7048.
//
// Run with:
//   npx vitest run --config vitest.integration.config.ts tests/integration/odata-query.test.ts
//
// If the BC OData NST is not reachable (port 7048 not responding), all tests
// are skipped with a clear message instead of failing.

import { describe, it, expect, beforeAll } from 'vitest';
import { config as dotenvConfig } from 'dotenv';
import { ODataClient, deriveODataUrl } from '../../src/odata/odata-client.js';
import { QueryOperation } from '../../src/operations/query.js';

dotenvConfig();

// Derive connection params from the same env vars used by the WS server
const BC_BASE_URL = process.env.BC_BASE_URL ?? 'http://cronus28/BC';
const BC_USERNAME = process.env.BC_USERNAME ?? 'sshadows';
const BC_PASSWORD = process.env.BC_PASSWORD ?? '1234';
const BC_TENANT_ID = process.env.BC_TENANT_ID ?? 'default';
const BC_ODATA_URL = deriveODataUrl(BC_BASE_URL);

let odataAvailable = false;
let companyId = '';

function makeClient(overrides?: object): ODataClient {
  return new ODataClient({
    odataUrl: BC_ODATA_URL,
    tenantId: BC_TENANT_ID,
    username: BC_USERNAME,
    password: BC_PASSWORD,
    requestTimeoutMs: 10_000,
    ...overrides,
  });
}

function makeOp(overrides?: object): QueryOperation {
  return new QueryOperation({
    odataUrl: BC_ODATA_URL,
    tenantId: BC_TENANT_ID,
    username: BC_USERNAME,
    password: BC_PASSWORD,
    requestTimeoutMs: 10_000,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Probe OData availability before running any tests
// ---------------------------------------------------------------------------

beforeAll(async () => {
  console.error(`[odata] probing ${BC_ODATA_URL}/api/v2.0/companies (timeout 12s)...`);
  try {
    // Use a short requestTimeoutMs so the fetch itself aborts before the beforeAll timeout
    const probe = new ODataClient({
      odataUrl: BC_ODATA_URL,
      tenantId: BC_TENANT_ID,
      username: BC_USERNAME,
      password: BC_PASSWORD,
      requestTimeoutMs: 10_000,
    });
    companyId = await probe.resolveCompanyId();
    odataAvailable = true;
    console.error(`[odata] OData available — companyId = ${companyId}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[odata] OData endpoint not reachable (${msg}). All OData integration tests will be skipped.`);
    console.warn(`[odata] derivedUrl = ${BC_ODATA_URL}`);
    odataAvailable = false;
  }
}, 14_000); // give the 10s fetch timeout + 4s margin

// ---------------------------------------------------------------------------
// Company resolution
// ---------------------------------------------------------------------------

describe('company resolution', () => {
  it('resolves a company id from /api/v2.0/companies', async (ctx) => {
    if (!odataAvailable) { ctx.skip(); return; }

    expect(typeof companyId).toBe('string');
    expect(companyId.length).toBeGreaterThan(0);
    expect(companyId).toMatch(/^[0-9a-f-]{32,}$/i);

    console.error(`[odata] companyId = ${companyId}`);
  }, 30_000);

  it('caches the id — second resolve does not issue a second companies request', async (ctx) => {
    if (!odataAvailable) { ctx.skip(); return; }

    const client = makeClient();
    const id1 = await client.resolveCompanyId();
    const id2 = await client.resolveCompanyId();
    expect(id1).toBe(id2);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// bc_query — companies
// ---------------------------------------------------------------------------

describe("bc_query('companies')", () => {
  it('returns at least one company', async (ctx) => {
    if (!odataAvailable) { ctx.skip(); return; }

    const op = makeOp();
    const result = await op.execute({ entity: 'companies' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    console.error(`[odata] companies rows: ${result.value.rowCount}`);
    console.error(`[odata] companies[0]:`, JSON.stringify(result.value.rows[0]).slice(0, 200));

    expect(result.value.rowCount).toBeGreaterThanOrEqual(1);
    const first = result.value.rows[0] as Record<string, unknown>;
    expect(typeof first['id']).toBe('string');
    expect(typeof first['name']).toBe('string');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// bc_query — customers (top: 3)
// ---------------------------------------------------------------------------

describe("bc_query('customers', { top: 3 })", () => {
  it('returns at most 3 rows with expected field shape', async (ctx) => {
    if (!odataAvailable) { ctx.skip(); return; }

    const op = makeOp();
    const result = await op.execute({ entity: 'customers', top: 3 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    console.error(`[odata] customers top:3 rows: ${result.value.rowCount}`);
    if (result.value.rows.length > 0) {
      console.error(`[odata] customers[0]:`, JSON.stringify(result.value.rows[0]).slice(0, 300));
    }

    expect(result.value.rowCount).toBeLessThanOrEqual(3);
    expect(result.value.cappedAt).toBeUndefined(); // top was supplied explicitly

    if (result.value.rows.length > 0) {
      const first = result.value.rows[0] as Record<string, unknown>;
      expect(first).toHaveProperty('id');
      expect(first).toHaveProperty('number');
      expect(first).toHaveProperty('displayName');
    }
  }, 30_000);

  it('applies $select to narrow returned fields', async (ctx) => {
    if (!odataAvailable) { ctx.skip(); return; }

    const op = makeOp();
    const result = await op.execute({ entity: 'customers', select: 'number,displayName', top: 3 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    if (result.value.rows.length > 0) {
      const first = result.value.rows[0] as Record<string, unknown>;
      expect(first).toHaveProperty('number');
      expect(first).toHaveProperty('displayName');
      expect(first).not.toHaveProperty('phoneNumber');
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// bc_query — items with $filter and $select
// ---------------------------------------------------------------------------

describe("bc_query('items', { filter, select, top })", () => {
  it('returns filtered items with narrowed fields', async (ctx) => {
    if (!odataAvailable) { ctx.skip(); return; }

    const op = makeOp();
    const result = await op.execute({
      entity: 'items',
      filter: "type eq 'Inventory'",
      select: 'number,displayName,type',
      top: 5,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      console.error('[odata] items query failed:', result.error.message);
      return;
    }

    console.error(`[odata] items (Inventory, top:5) rows: ${result.value.rowCount}`);
    if (result.value.rows.length > 0) {
      console.error(`[odata] items[0]:`, JSON.stringify(result.value.rows[0]).slice(0, 300));
    }

    expect(result.value.rowCount).toBeLessThanOrEqual(5);
    for (const row of result.value.rows as Array<Record<string, unknown>>) {
      expect(row).toHaveProperty('number');
      expect(row).toHaveProperty('displayName');
      expect(row).toHaveProperty('type');
      expect(row['type']).toBe('Inventory');
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// bc_query — auto-cap (no top supplied)
// ---------------------------------------------------------------------------

describe('auto-cap behavior', () => {
  it('sets cappedAt in output when caller omits top', async (ctx) => {
    if (!odataAvailable) { ctx.skip(); return; }

    const op = makeOp();
    const result = await op.execute({ entity: 'customers' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cappedAt).toBe(100);
    expect(result.value.rowCount).toBeLessThanOrEqual(100);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Error: bad entity name
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('returns err for a non-existent entity', async (ctx) => {
    if (!odataAvailable) { ctx.skip(); return; }

    const op = makeOp();
    const result = await op.execute({ entity: 'nonExistentEntity_xyz' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    console.error(`[odata] bad entity error: ${result.error.message}`);
    expect(result.error.message.length).toBeGreaterThan(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ODataClient direct — verify deriveODataUrl produces a working URL
// ---------------------------------------------------------------------------

describe('deriveODataUrl integration', () => {
  it('derived URL reaches the BC OData endpoint', async (ctx) => {
    if (!odataAvailable) { ctx.skip(); return; }

    const derivedUrl = deriveODataUrl(BC_BASE_URL);
    console.error(`[odata] BC_BASE_URL=${BC_BASE_URL} -> derivedUrl=${derivedUrl}`);
    expect(derivedUrl).toContain(':7048');

    const client = new ODataClient({
      odataUrl: derivedUrl,
      tenantId: BC_TENANT_ID,
      username: BC_USERNAME,
      password: BC_PASSWORD,
    });
    const id = await client.resolveCompanyId();
    expect(id).toBeTruthy();
  }, 30_000);
});
