import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Deliberately no dotenv import. Execute only from the reviewed source snapshot.
if (
  readdirSync(process.cwd()).some((name) => /^\.env(?:\.|$)/.test(name) && name !== '.env.example')
)
  throw new Error('Document acceptance requires a snapshot without real environment files.');
// Inspect generated metadata as text; never import Prisma during config/discovery.
// A reused client must not carry a path that could load the source repository's .env.
const resolveClient = createRequire(join(process.cwd(), 'package.json'));
const client = resolveClient.resolve('@prisma/client');
const generated = createRequire(client).resolve('.prisma/client/default');
const metadata = readFileSync(join(dirname(generated), 'index.js'), 'utf8').match(
  /"relativeEnvPaths":\s*(\{[^}]*\})/,
);
if (!metadata || Object.values(JSON.parse(metadata[1])).some(Boolean))
  throw new Error('Generated Prisma client has unreviewed environment-file paths; stop.');
const discovery = process.argv.includes('--list');
if (!discovery && process.env.M41_BROWSER_ACCEPTANCE !== 'devflow_test-only')
  throw new Error('Explicit M4.1 browser execution authorization is required.');
let database: URL;
try {
  database = new URL(
    process.env.TEST_DATABASE_URL ??
      (discovery
        ? 'postgresql://synthetic:synthetic@127.0.0.1:5433/devflow_test?schema=public'
        : ''),
  );
} catch {
  throw new Error('A valid approved test database URL is required; value withheld.');
}
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  !['localhost', '127.0.0.1'].includes(database.hostname) ||
  database.port !== '5433' ||
  database.hash !== '' ||
  database.searchParams.size > 1 ||
  decodeURIComponent(database.pathname) !== '/devflow_test' ||
  [...database.searchParams.keys()].some((key) => key !== 'schema') ||
  (database.searchParams.get('schema') ?? 'public') !== 'public'
)
  throw new Error('Only local port 5433 devflow_test/public is permitted.');
const baseURL = 'http://127.0.0.1:3101';
export default defineConfig({
  testDir: '.',
  testMatch: 'documents.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120000,
  outputDir: '../test-results/documents',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/documents', open: 'never' }]],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3101',
    url: `${baseURL}/login`,
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      DATABASE_URL: database.href,
      TEST_DATABASE_URL: database.href,
      APP_URL: baseURL,
      AI_API_KEY: '',
      AI_BASE_URL: 'http://127.0.0.1:1',
      GITHUB_CLIENT_ID: '',
      GITHUB_CLIENT_SECRET: '',
      GITHUB_WEBHOOK_SECRET: '',
      GITHUB_DEMO: 'false',
      TOKEN_ENCRYPTION_KEY: '',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});
