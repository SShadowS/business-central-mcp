import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60000,
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['tests/integration/phase4-destructive.test.ts', 'tests/integration/saas-web-session.test.ts'],
    // Single process, serial: the IntegrationSessionPool singleton is shared
    // across files, and BC's wire protocol is stateful (one session at a time).
    // NOTE: vitest 4 removed poolOptions; fileParallelism:false forces maxWorkers=1.
    fileParallelism: false,
    pool: 'forks',
    // isolate:false so the IntegrationSessionPool module singleton is shared across files.
    isolate: false,
  },
});
