import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 90000,
    // See vitest.integration.config.ts: a timed-out beforeAll leaks its pool checkout.
    hookTimeout: 120000,
    // Every test that modifies an existing BC record (or posts/deletes) lives in a
    // `*-destructive.test.ts` file. Run only with the maintainer's permission.
    include: ['tests/integration/**/*-destructive.test.ts'],
    globalSetup: ['tests/integration/helpers/global-setup.ts'],
    // Same as the integration tier: one process, serial, shared IntegrationSessionPool.
    fileParallelism: false,
    pool: 'forks',
    isolate: false,
  },
});
