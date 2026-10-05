import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    // PDF rendering/font work and disposable PostgreSQL clusters are resource-heavy.
    // Bound parallel suites so host CPU contention does not consume per-test deadlines.
    maxWorkers: 2,
  },
});
