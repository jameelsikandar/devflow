import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  server: { hmr: false },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.integration.test.ts'],
    pool: 'threads',
    maxWorkers: 1,
    minWorkers: 1,
  },
});
