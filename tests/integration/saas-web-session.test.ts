/**
 * Live smoke for BC Online `/csh` through production modules.
 *
 * Requires a SaaS `BC_BASE_URL` and `STATE_DIR/saas-web-cookies.json`
 * from a prior sign-in (`npx tsx src/stdio-server.ts login` or first
 * `bc_open_page`). Does not require `BC_PASSWORD`. Do not commit cookies.
 */
import { describe, it, expect } from 'vitest';
import { config as dotenvConfig } from 'dotenv';
import { parseSaasUrl } from '../../src/connection/saas-url.js';
import { saasCookieStorePath, FileCookieStore } from '../../src/connection/auth/saas/cookie-store.js';
import { SaasWebSessionProvider } from '../../src/connection/auth/saas-web-session-provider.js';
import { ConnectionFactory } from '../../src/connection/connection-factory.js';
import { SessionFactory } from '../../src/session/session-factory.js';
import { EventDecoder } from '../../src/protocol/event-decoder.js';
import { InteractionEncoder } from '../../src/protocol/interaction-encoder.js';
import { PageContextRepository } from '../../src/protocol/page-context-repo.js';
import { PageService } from '../../src/services/page-service.js';
import { loadConfig } from '../../src/core/config.js';
import { createNullLogger } from '../../src/core/logger.js';
import { err } from '../../src/core/result.js';
import { SignInRequiredError } from '../../src/core/errors.js';
import { fields } from '../../src/protocol/form-views.js';

dotenvConfig();

const saas = parseSaasUrl(process.env.BC_BASE_URL ?? '');
const stateDir = process.env.STATE_DIR || './.state';
const cookiePath = saasCookieStorePath(stateDir);

describe('SaaS web session smoke', () => {
  it('OpenSession uses a runtime id and openPage(22) returns rows', async () => {
    expect(saas, 'BC_BASE_URL must be a businesscentral.dynamics.com/{tenant}/{env} URL').toBeTruthy();
    if (!saas) return;

    const cookies = new FileCookieStore(cookiePath).load(saas.aadTenantId, saas.environmentName);
    expect(cookies, `missing ${cookiePath} — run npx tsx src/stdio-server.ts login`).toBeTruthy();

    const config = loadConfig();
    const logger = createNullLogger();
    const provider = new SaasWebSessionProvider({
      saas,
      stateDir,
      usernamePrefill: config.bc.username,
      loginTimeoutMs: 5_000,
      opener: { open: () => false },
      ensurePortalSession: async () => err(new SignInRequiredError(
        'A display is required to sign in to Business Central Online.',
        { openedWindow: false, reason: 'no_display' },
      )),
      logger,
    });

    const auth = await provider.authenticate();
    expect(auth.ok, auth.ok ? undefined : auth.error.message).toBe(true);
    if (!auth.ok) return;

    const factory = new ConnectionFactory(provider, config.bc, logger);
    const sessions = new SessionFactory(
      factory,
      new EventDecoder(),
      new InteractionEncoder(config.bc.clientVersionString, config.bc.applicationId),
      logger,
      config.bc.tenantId,
      config.bc.invokeTimeoutMs,
      config.bc.profile,
      () => provider.getSessionTenantId?.() ?? config.bc.tenantId,
    );
    const created = await sessions.create();
    expect(created.ok, created.ok ? undefined : created.error.message).toBe(true);
    if (!created.ok) return;

    const session = created.value;
    try {
      expect(session.companyName.length).toBeGreaterThan(0);
      const runtimeId = provider.getSessionTenantId();
      expect(runtimeId).toBeTruthy();
      expect(runtimeId).not.toBe(saas.aadTenantId);
      expect(runtimeId).toMatch(/^msft/i);

      const repo = new PageContextRepository();
      const pages = new PageService(session, repo, logger);
      const opened = await pages.openPage('22');
      expect(opened.ok, opened.ok ? undefined : opened.error.message).toBe(true);
      if (!opened.ok) return;
      let rowCount = 0;
      for (const form of opened.value.forms.values()) {
        for (const rows of form.rows.values()) rowCount += rows.length;
      }
      expect(rowCount).toBeGreaterThan(0);
    } finally {
      session.close();
    }
  });

  it('openPage(21) returns captioned fields', async () => {
    expect(saas, 'BC_BASE_URL must be a businesscentral.dynamics.com/{tenant}/{env} URL').toBeTruthy();
    if (!saas) return;

    const config = loadConfig();
    const logger = createNullLogger();
    const provider = new SaasWebSessionProvider({
      saas,
      stateDir,
      usernamePrefill: config.bc.username,
      loginTimeoutMs: 5_000,
      opener: { open: () => false },
      ensurePortalSession: async () => err(new SignInRequiredError(
        'A display is required to sign in to Business Central Online.',
        { openedWindow: false, reason: 'no_display' },
      )),
      logger,
    });
    const auth = await provider.authenticate();
    expect(auth.ok, auth.ok ? undefined : auth.error.message).toBe(true);
    if (!auth.ok) return;

    const factory = new ConnectionFactory(provider, config.bc, logger);
    const sessions = new SessionFactory(
      factory,
      new EventDecoder(),
      new InteractionEncoder(config.bc.clientVersionString, config.bc.applicationId),
      logger,
      config.bc.tenantId,
      config.bc.invokeTimeoutMs,
      config.bc.profile,
      () => provider.getSessionTenantId?.() ?? config.bc.tenantId,
    );
    const created = await sessions.create();
    expect(created.ok, created.ok ? undefined : created.error.message).toBe(true);
    if (!created.ok) return;

    const session = created.value;
    try {
      const repo = new PageContextRepository();
      const pages = new PageService(session, repo, logger);
      const opened = await pages.openPage('21');
      expect(opened.ok, opened.ok ? undefined : opened.error.message).toBe(true);
      if (!opened.ok) return;
      const root = opened.value.forms.get(opened.value.rootFormId);
      expect(root).toBeTruthy();
      if (!root) return;
      expect(fields(root.root).length).toBeGreaterThan(0);
    } finally {
      session.close();
    }
  });
});
