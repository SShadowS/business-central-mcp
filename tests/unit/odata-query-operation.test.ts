// tests/unit/odata-query-operation.test.ts
//
// Unit tests for QueryOperation.
// Mocks global fetch — no real BC connection required.

import { describe, it, expect, vi } from 'vitest';
import { QueryOperation } from '../../src/operations/query.js';

function makeConfig(overrides?: object) {
  return {
    odataUrl: 'http://cronus28:7048/BC',
    tenantId: 'default',
    username: 'user',
    password: 'pass',
    defaultTop: 100,
    ...overrides,
  };
}

function mockFetch(...responses: Array<{ ok: boolean; status: number; body: unknown }>) {
  let call = 0;
  return vi.fn(async () => {
    const resp = responses[call++] ?? responses[responses.length - 1]!;
    return { ok: resp.ok, status: resp.status, json: async () => resp.body };
  });
}

const companiesOk = { ok: true, status: 200, body: { value: [{ id: 'co-id', name: 'CRONUS' }] } };

describe('QueryOperation', () => {
  it('returns ok with rows on success', async () => {
    const rows = [{ number: 'C001', displayName: 'Alice' }];
    global.fetch = mockFetch(companiesOk, { ok: true, status: 200, body: { value: rows } }) as unknown as typeof fetch;

    const op = new QueryOperation(makeConfig());
    const result = await op.execute({ entity: 'customers' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entity).toBe('customers');
    expect(result.value.rows).toEqual(rows);
    expect(result.value.rowCount).toBe(1);
  });

  it('sets cappedAt when caller did not supply top', async () => {
    global.fetch = mockFetch(companiesOk, { ok: true, status: 200, body: { value: [] } }) as unknown as typeof fetch;

    const op = new QueryOperation(makeConfig({ defaultTop: 50 }));
    const result = await op.execute({ entity: 'items' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cappedAt).toBe(50);
  });

  it('does not set cappedAt when caller supplied top explicitly', async () => {
    global.fetch = mockFetch(companiesOk, { ok: true, status: 200, body: { value: [] } }) as unknown as typeof fetch;

    const op = new QueryOperation(makeConfig());
    const result = await op.execute({ entity: 'items', top: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cappedAt).toBeUndefined();
  });

  it('returns err on 401', async () => {
    global.fetch = mockFetch(companiesOk, { ok: false, status: 401, body: {} }) as unknown as typeof fetch;

    const op = new QueryOperation(makeConfig());
    const result = await op.execute({ entity: 'customers' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('401');
  });

  it('returns err on BC error body', async () => {
    global.fetch = mockFetch(
      companiesOk,
      { ok: false, status: 400, body: { error: { code: 'BadFilter', message: 'Invalid $filter' } } },
    ) as unknown as typeof fetch;

    const op = new QueryOperation(makeConfig());
    const result = await op.execute({ entity: 'customers', filter: 'bad syntax' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Invalid $filter');
  });

  it('returns err on network failure', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

    const op = new QueryOperation(makeConfig());
    const result = await op.execute({ entity: 'customers' });

    expect(result.ok).toBe(false);
  });

  it('passes filter, select, orderby to client', async () => {
    const fetchMock = mockFetch(companiesOk, { ok: true, status: 200, body: { value: [] } });
    global.fetch = fetchMock as unknown as typeof fetch;

    await new QueryOperation(makeConfig()).execute({
      entity: 'items',
      filter: "displayName eq 'Test'",
      select: 'number,displayName',
      orderby: 'number asc',
    });

    const url: string = fetchMock.mock.calls[1]![0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("$filter=displayName eq 'Test'");
    expect(decoded).toContain('$select=number,displayName');
    expect(decoded).toContain('$orderby=number asc');
  });
});
