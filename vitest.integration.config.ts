import 'dotenv/config';
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { requireTestDatabase } from './tests/database-config';
const testUrl = requireTestDatabase(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
process.env.DATABASE_URL = testUrl.href;
process.env.APP_URL = 'http://localhost:3000';
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['tests/**/*.integration.test.ts'],
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
