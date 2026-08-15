import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 120000,
    include: ['tests/integration/saas-web-session.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    isolate: false,
  },
});
