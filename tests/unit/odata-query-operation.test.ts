// tests/unit/odata-query-operation.test.ts
//
// Unit tests for QueryOperation.
// Mocks global fetch — no real BC connection required.

import { describe, it, expect, vi } from 'vitest';
import { QueryOperation, createQueryOperation } from '../../src/operations/query.js';
import type { AppConfig } from '../../src/core/config.js';
import type { IBCAuthProvider } from '../../src/connection/auth/auth-provider.js';
import { QuerySchema } from '../../src/mcp/schemas.js';

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

describe('QueryOperation requireBearer', () => {
  it('returns OAUTH_NOT_CONFIGURED with no getAuthorization and does not fetch', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const op = new QueryOperation({
      odataUrl: 'https://api.businesscentral.dynamics.com/v2.0/t/DEV',
      tenantId: 't',
      username: 'user@t.com',
      password: '',
    }, { requireBearer: true });
    const result = await op.execute({ entity: 'customers' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('OAUTH_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns OAUTH_NOT_CONFIGURED when getAuthorization yields undefined (no Basic)', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const op = new QueryOperation({
      odataUrl: 'https://api.businesscentral.dynamics.com/v2.0/t/DEV',
      tenantId: 't',
      username: 'user@t.com',
      password: '',
      getAuthorization: async () => undefined,
    }, { requireBearer: true });
    const result = await op.execute({ entity: 'customers' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('OAUTH_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requireBearer false still uses Basic (on-prem)', async () => {
    global.fetch = mockFetch(companiesOk, { ok: true, status: 200, body: { value: [] } }) as unknown as typeof fetch;
    const op = new QueryOperation(makeConfig({ username: 'user', password: 'pass' }), { requireBearer: false });
    const result = await op.execute({ entity: 'customers' });
    expect(result.ok).toBe(true);
  });
});

describe('createQueryOperation requireBearer on SaasWeb', () => {
  it('does not call uiAuth.prepareConnection and rejects without a Bearer', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const prepareConnection = vi.fn();
    const uiAuth = {
      authenticate: async () => ({ ok: true, value: { cookies: '', csrfToken: '' } }),
      getWebSocketHeaders: () => ({}),
      getWebSocketQueryParams: () => ({}),
      isAuthenticated: () => false,
      invalidate: () => {},
      prepareConnection,
    } as unknown as IBCAuthProvider;
    const config = {
      bc: {
        odataUrl: 'https://api.businesscentral.dynamics.com/v2.0/t/DEV',
        tenantId: 't',
        username: 'user@t.com',
        password: '',
        odataCompanyName: undefined,
        appendTenantQuery: false,
        authMode: 'SaasWeb',
      },
    } as AppConfig;
    const op = createQueryOperation(config, uiAuth);
    const result = await op.execute({ entity: 'customers' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('OAUTH_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prepareConnection).not.toHaveBeenCalled();
  });
});

describe('QuerySchema entity validation', () => {
  it('accepts valid camelCase API identifiers', () => {
    for (const entity of ['items', 'salesOrders', 'generalLedgerEntries', 'dimension_values', 'C']) {
      expect(QuerySchema.safeParse({ entity }).success, entity).toBe(true);
    }
  });

  it('rejects an entity containing "?" (query-injection / cap bypass)', () => {
    const result = QuerySchema.safeParse({ entity: 'items?$top=999999' });
    expect(result.success).toBe(false);
  });

  it('rejects an entity containing "/" (path traversal)', () => {
    expect(QuerySchema.safeParse({ entity: '../accounts' }).success).toBe(false);
    expect(QuerySchema.safeParse({ entity: 'items/123' }).success).toBe(false);
  });

  it('rejects an entity containing a space', () => {
    expect(QuerySchema.safeParse({ entity: 'sales orders' }).success).toBe(false);
  });

  it('rejects an entity starting with a digit', () => {
    expect(QuerySchema.safeParse({ entity: '1items' }).success).toBe(false);
  });

  it('rejects an empty entity', () => {
    expect(QuerySchema.safeParse({ entity: '' }).success).toBe(false);
  });
});
