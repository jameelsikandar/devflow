import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';
import { requireTestDatabase } from './tests/database-config';
const database = requireTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100';
const origin = new URL(baseURL);
if (!['localhost', '127.0.0.1'].includes(origin.hostname) || origin.protocol !== 'http:')
  throw new Error(
    'E2E_BASE_URL must be a local HTTP origin; Playwright starts its own isolated server.',
  );
const port = Number(origin.port || 80);
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { baseURL: origin.origin, trace: 'retain-on-failure' },
  webServer: {
    command: `node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port ${port}`,
    url: `${origin.origin}/login`,
    // AI browser responses are fixtures; never inherit live provider credentials.
    env: { DATABASE_URL: database.href, APP_URL: origin.origin, AI_API_KEY: '' },
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});
