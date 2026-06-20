// tests/unit/odata-client.test.ts
//
// Unit tests for ODataClient and deriveODataUrl.
// Mocks global fetch — no real BC connection required.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ODataClient, ODataError, deriveODataUrl } from '../../src/odata/odata-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<ConstructorParameters<typeof ODataClient>[0]>) {
  return {
    odataUrl: 'http://cronus28:7048/BC',
    tenantId: 'default',
    username: 'user',
    password: 'pass',
    ...overrides,
  };
}

function mockFetch(responses: Array<{ ok: boolean; status: number; body: unknown }>) {
  let call = 0;
  return vi.fn(async () => {
    const resp = responses[call++] ?? responses[responses.length - 1]!;
    return {
      ok: resp.ok,
      status: resp.status,
      json: async () => resp.body,
    };
  });
}

function companiesResponse(companies: Array<{ id: string; name: string }>) {
  return { ok: true, status: 200, body: { value: companies } };
}

function rowsResponse(rows: unknown[]) {
  return { ok: true, status: 200, body: { value: rows } };
}

// ---------------------------------------------------------------------------
// deriveODataUrl
// ---------------------------------------------------------------------------

describe('deriveODataUrl', () => {
  beforeEach(() => {
    delete process.env.BC_ODATA_URL;
  });
  afterEach(() => {
    delete process.env.BC_ODATA_URL;
  });

  it('injects port 7048 into a plain hostname URL', () => {
    expect(deriveODataUrl('http://cronus28/BC')).toBe('http://cronus28:7048/BC');
  });

  it('replaces an existing non-7048 port', () => {
    expect(deriveODataUrl('http://cronus28:80/BC')).toBe('http://cronus28:7048/BC');
  });

  it('leaves port 7048 unchanged', () => {
    expect(deriveODataUrl('http://cronus28:7048/BC')).toBe('http://cronus28:7048/BC');
  });

  it('strips trailing slashes', () => {
    expect(deriveODataUrl('http://cronus28/BC/')).toBe('http://cronus28:7048/BC');
  });

  it('respects BC_ODATA_URL env var over derivation', () => {
    process.env.BC_ODATA_URL = 'http://custom-odata:9999/BC';
    expect(deriveODataUrl('http://cronus28/BC')).toBe('http://custom-odata:9999/BC');
  });

  it('strips trailing slash from BC_ODATA_URL', () => {
    process.env.BC_ODATA_URL = 'http://custom-odata:9999/BC/';
    expect(deriveODataUrl('http://cronus28/BC')).toBe('http://custom-odata:9999/BC');
  });
});

// ---------------------------------------------------------------------------
// Company resolution
// ---------------------------------------------------------------------------

describe('ODataClient.resolveCompanyId', () => {
  it('calls /api/v2.0/companies with tenant param and returns id', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'abc-123', name: 'CRONUS Danmark A/S' }]),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new ODataClient(makeConfig());
    const id = await client.resolveCompanyId();

    expect(id).toBe('abc-123');
    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl: string = fetchMock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('/api/v2.0/companies');
    expect(calledUrl).toContain('tenant=default');
  });

  it('caches the company id — fetch called only once for repeated calls', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'abc-123', name: 'CRONUS' }]),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new ODataClient(makeConfig());
    await client.resolveCompanyId();
    await client.resolveCompanyId();
    await client.resolveCompanyId();

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('concurrent calls share one in-flight fetch (no double-resolution)', async () => {
    let resolveCount = 0;
    const fetchMock = vi.fn(async () => {
      resolveCount++;
      return { ok: true, status: 200, json: async () => ({ value: [{ id: 'x', name: 'Co' }] }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new ODataClient(makeConfig());
    await Promise.all([client.resolveCompanyId(), client.resolveCompanyId(), client.resolveCompanyId()]);
    expect(resolveCount).toBe(1);
  });

  it('picks company by configured name (case-insensitive)', async () => {
    const fetchMock = mockFetch([
      companiesResponse([
        { id: 'id-a', name: 'Company A' },
        { id: 'id-b', name: 'Company B' },
      ]),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new ODataClient(makeConfig({ defaultCompanyName: 'company b' }));
    const id = await client.resolveCompanyId();
    expect(id).toBe('id-b');
  });

  it('throws ODataError if configured company not found', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'id-a', name: 'Company A' }]),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new ODataClient(makeConfig({ defaultCompanyName: 'Missing Co' }));
    await expect(client.resolveCompanyId()).rejects.toBeInstanceOf(ODataError);
  });

  it('throws ODataError when companies array is empty', async () => {
    const fetchMock = mockFetch([companiesResponse([])]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new ODataClient(makeConfig());
    await expect(client.resolveCompanyId()).rejects.toBeInstanceOf(ODataError);
  });

  it('uses first company when no defaultCompanyName is set', async () => {
    const fetchMock = mockFetch([
      companiesResponse([
        { id: 'first', name: 'First Co' },
        { id: 'second', name: 'Second Co' },
      ]),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new ODataClient(makeConfig());
    const id = await client.resolveCompanyId();
    expect(id).toBe('first');
  });
});

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

describe('ODataClient.query — URL construction', () => {
  it('builds entity URL under companies(<id>) segment', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'co-id', name: 'Co' }]),
      rowsResponse([]),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new ODataClient(makeConfig());
    await client.query('customers');

    const entityUrl: string = fetchMock.mock.calls[1]![0] as string;
    expect(entityUrl).toContain('/api/v2.0/companies(co-id)/customers');
  });

  it('appends $filter when provided', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'co-id', name: 'Co' }]),
      rowsResponse([]),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await new ODataClient(makeConfig()).query('customers', { filter: "city eq 'London'" });

    const url: string = fetchMock.mock.calls[1]![0] as string;
    expect(decodeURIComponent(url)).toContain("$filter=city eq 'London'");
  });

  it('appends $select when provided', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'co-id', name: 'Co' }]),
      rowsResponse([]),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await new ODataClient(makeConfig()).query('customers', { select: 'number,displayName' });

    const url: string = fetchMock.mock.calls[1]![0] as string;
    expect(decodeURIComponent(url)).toContain('$select=number,displayName');
  });

  it('appends $orderby when provided', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'co-id', name: 'Co' }]),
      rowsResponse([]),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await new ODataClient(makeConfig()).query('customers', { orderby: 'displayName asc' });

    const url: string = fetchMock.mock.calls[1]![0] as string;
    expect(decodeURIComponent(url)).toContain('$orderby=displayName asc');
  });

  it('applies caller-supplied top exactly', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'co-id', name: 'Co' }]),
      rowsResponse([]),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await new ODataClient(makeConfig()).query('customers', { top: 42 });

    const url: string = fetchMock.mock.calls[1]![0] as string;
    expect(url).toContain('$top=42');
  });

  it('applies default top (100) when caller omits top', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'co-id', name: 'Co' }]),
      rowsResponse([]),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await new ODataClient(makeConfig()).query('items');

    const url: string = fetchMock.mock.calls[1]![0] as string;
    expect(url).toContain('$top=100');
  });

  it('respects custom defaultTop from config', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'co-id', name: 'Co' }]),
      rowsResponse([]),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await new ODataClient(makeConfig({ defaultTop: 25 })).query('items');

    const url: string = fetchMock.mock.calls[1]![0] as string;
    expect(url).toContain('$top=25');
  });

  it('includes tenant param on entity query', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'co-id', name: 'Co' }]),
      rowsResponse([]),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await new ODataClient(makeConfig({ tenantId: 'mytenant' })).query('customers');

    const url: string = fetchMock.mock.calls[1]![0] as string;
    expect(url).toContain('tenant=mytenant');
  });

  it('sends Basic auth header', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'co-id', name: 'Co' }]),
      rowsResponse([]),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await new ODataClient(makeConfig({ username: 'admin', password: 'secret' })).query('items');

    const callArgs = fetchMock.mock.calls[1]! as [string, RequestInit];
    const headers = callArgs[1]?.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from('admin:secret').toString('base64')}`;
    expect(headers['Authorization']).toBe(expected);
  });

  it('returns parsed rows from value array', async () => {
    const rows = [{ id: '1', displayName: 'Alice' }, { id: '2', displayName: 'Bob' }];
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'co-id', name: 'Co' }]),
      rowsResponse(rows),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await new ODataClient(makeConfig()).query('customers');
    expect(result.rows).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('ODataClient — error handling', () => {
  it('maps 401 to ODataError with credential hint', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'co-id', name: 'Co' }]),
      { ok: false, status: 401, body: {} },
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(new ODataClient(makeConfig()).query('customers')).rejects.toSatisfy(
      (e: unknown) => e instanceof ODataError && e.statusCode === 401 && e.message.includes('Basic auth'),
    );
  });

  it('maps non-401 BC error body to ODataError with message', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'co-id', name: 'Co' }]),
      {
        ok: false,
        status: 400,
        body: { error: { code: 'BadRequest', message: 'Invalid filter' } },
      },
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(new ODataClient(makeConfig()).query('customers')).rejects.toSatisfy(
      (e: unknown) => e instanceof ODataError && e.message.includes('Invalid filter') && e.statusCode === 400,
    );
  });

  it('maps 404 to ODataError even without a JSON body', async () => {
    const fetchMock = vi.fn(async (_url: string) => {
      // companies succeeds
      if ((_url as string).includes('/companies?')) {
        return { ok: true, status: 200, json: async () => ({ value: [{ id: 'co-id', name: 'Co' }] }) };
      }
      return { ok: false, status: 404, json: async () => { throw new Error('no body'); } };
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(new ODataClient(makeConfig()).query('noSuchEntity')).rejects.toBeInstanceOf(ODataError);
  });

  it('maps network failure to ODataError', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(new ODataClient(makeConfig()).query('customers')).rejects.toBeInstanceOf(ODataError);
  });

  it('surfaces BC error code on ODataError instance', async () => {
    const fetchMock = mockFetch([
      companiesResponse([{ id: 'co-id', name: 'Co' }]),
      {
        ok: false,
        status: 400,
        body: { error: { code: 'BC_INVALID_FILTER', message: 'bad filter' } },
      },
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      await new ODataClient(makeConfig()).query('customers');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ODataError);
      expect((e as ODataError).bcErrorCode).toBe('BC_INVALID_FILTER');
    }
  });
});
