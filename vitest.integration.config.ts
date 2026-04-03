import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60000,
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['tests/integration/phase4-destructive.test.ts'],
  },
});
