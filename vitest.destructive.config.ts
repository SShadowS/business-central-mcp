import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 90000,
    include: ['tests/integration/phase4-destructive.test.ts', 'tests/integration/replay-post-destructive.test.ts'],
    // Same as the integration tier: one process, serial, shared IntegrationSessionPool.
    fileParallelism: false,
    pool: 'forks',
    isolate: false,
  },
});
