// tests/integration/switch-company.test.ts
//
// Live company-switch verification against Cronus28.
//
// Guards the regression fixed in SwitchCompanyOperation: BC binds a session to
// a company ONLY at OpenSession time. The old implementation invoked
// ChangeCompany (SystemAction 500), which returns InvokeCompleted while leaving
// the session in the OLD company -- the switch never stuck. The fix re-opens
// the session bound to the target company.
//
// This test proves a REAL switch by comparing customer-list contents before and
// after (two demo companies differ), not just the echoed company name (which the
// buggy code also returned correctly).
//
// Requires >=2 companies on the box (cronus28 has "CRONUS Danmark A/S" +
// "My Company"). On a single-company env the data-switch assertions are skipped.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createNullLogger } from '../../src/core/logger.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import type { BCSession } from '../../src/session/bc-session.js';
import { PageService } from '../../src/services/page-service.js';
import { DataService } from '../../src/services/data-service.js';
import { ListCompaniesOperation } from '../../src/operations/list-companies.js';
import { SwitchCompanyOperation } from '../../src/operations/switch-company.js';
import { isOk, unwrap } from '../../src/core/result.js';
import { integrationPool, type PooledLease } from './helpers/session-pool.js';

// A stable signature of the customer list (page 22) that differs per company.
async function customerSignature(session: BCSession): Promise<string> {
  const logger = createNullLogger();
  const repo = new PageContextRepository();
  const pageService = new PageService(session, repo, logger);
  const dataService = new DataService(session, repo, logger);
  const open = await pageService.openPage('22');
  if (!isOk(open)) return `open-fail`;
  const rows = dataService.readRows(open.value.pageContextId);
  let sig = 'read-fail';
  if (isOk(rows)) {
    const ids = rows.value.slice(0, 5).map(r => {
      const cells = r.cells as Record<string, unknown>;
      const no = Object.entries(cells).find(([k]) => k.toLowerCase().startsWith('no'))?.[1];
      const name = Object.entries(cells).find(([k]) => k.toLowerCase() === 'name')?.[1];
      return `${no ?? '?'}:${name ?? '?'}`;
    });
    sig = `n=${rows.value.length}|${ids.join(',')}`;
  }
  await pageService.closePage(open.value.pageContextId).catch(() => {});
  return sig;
}

describe.sequential('Company switch (live)', () => {
  const logger = createNullLogger();
  let lease: PooledLease;
  let session: BCSession;
  let repo: PageContextRepository;
  let switchOp: SwitchCompanyOperation;
  let companies: string[] = [];
  let original = '';

  beforeAll(async () => {
    lease = await integrationPool.checkOut();
    session = lease.session;
    repo = new PageContextRepository();
    const pageService = new PageService(session, repo, logger);
    const dataService = new DataService(session, repo, logger);
    switchOp = new SwitchCompanyOperation(session, repo, logger);

    const listOp = new ListCompaniesOperation(pageService, dataService, () => session.companyName, logger);
    const res = await listOp.execute();
    if (isOk(res)) {
      companies = res.value.companies.map(c => c.name).filter(Boolean);
      original = res.value.currentCompany;
    }
  });

  afterAll(async () => {
    // Best-effort restore (harmless -- the pool tears the session down anyway).
    if (session && original && session.companyName !== original) {
      await switchOp.execute({ companyName: original }).catch(() => {});
    }
    if (lease) await integrationPool.checkIn(lease, { poisoned: !session?.isAlive });
  });

  it('lists at least one company and reports the current one', () => {
    expect(companies.length).toBeGreaterThan(0);
    expect(original).toBeTruthy();
    expect(companies).toContain(original);
  });

  it('switches company for real: customer-list contents change, then round-trips back', async () => {
    const target = companies.find(c => c !== original);
    if (!target) {
      console.warn('[switch-company] single-company env; skipping data-switch assertions');
      return;
    }

    const sigBefore = await customerSignature(session);

    // seed a page context so we can prove invalidation
    const pageService = new PageService(session, repo, logger);
    await pageService.openPage('22');
    expect(repo.listPageContextIds().length).toBeGreaterThan(0);

    const sw = await switchOp.execute({ companyName: target });
    expect(sw.ok).toBe(true);
    const out = unwrap(sw);
    expect(out.previousCompany).toBe(original);
    expect(out.newCompany).toBe(target);
    expect(session.companyName).toBe(target);
    // page contexts invalidated on switch
    expect(repo.listPageContextIds().length).toBe(0);

    // The decisive check: server-side data actually changed company.
    const sigAfter = await customerSignature(session);
    expect(sigAfter).not.toBe(sigBefore);

    // round-trip back
    const back = await switchOp.execute({ companyName: original });
    expect(back.ok).toBe(true);
    expect(session.companyName).toBe(original);
    const sigRestored = await customerSignature(session);
    expect(sigRestored).toBe(sigBefore);
  });

  it('rejects an unknown company with COMPANY_NOT_FOUND and stays on the current company', async () => {
    const before = session.companyName;
    const res = await switchOp.execute({ companyName: 'ZZ No Such Company ZZ' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('COMPANY_NOT_FOUND');
    expect(session.companyName).toBe(before);
    // session still usable
    const sig = await customerSignature(session);
    expect(sig).not.toBe('open-fail');
  });

  it('rejects a wrong-case company name (OpenSession company is case-sensitive)', async () => {
    const target = companies.find(c => c !== original);
    if (!target) return;
    const wrongCase = target.toUpperCase() === target ? target.toLowerCase() : target.toUpperCase();
    if (wrongCase === target) return; // no case to vary
    const before = session.companyName;
    const res = await switchOp.execute({ companyName: wrongCase });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('COMPANY_NOT_FOUND');
    expect(session.companyName).toBe(before);
  });
});
