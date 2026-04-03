import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 90000,
    include: ['tests/integration/phase4-destructive.test.ts'],
  },
});
