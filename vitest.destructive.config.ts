import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 90000,
    // Every test that modifies an existing BC record (or posts/deletes) lives in a
    // `*-destructive.test.ts` file. Run only with the maintainer's permission.
    include: ['tests/integration/**/*-destructive.test.ts'],
    // Same as the integration tier: one process, serial, shared IntegrationSessionPool.
    fileParallelism: false,
    pool: 'forks',
    isolate: false,
  },
});
