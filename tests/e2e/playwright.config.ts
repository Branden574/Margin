import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: [['list']],
  use: {
    ignoreHTTPSErrors: true,
    launchOptions: { args: ['--ignore-certificate-errors'] },
    baseURL: process.env.MARGIN_E2E_URL || 'https://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: {
    ignoreHTTPSErrors: true,
    command:
      'npm run setup:dev && npm run dev -w @margin/web -- --host 127.0.0.1 --port 5173 --strictPort',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: 'https://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
