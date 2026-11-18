import { defineConfig } from 'vitest/config';
// Deliberately separate: no dotenv, application setup, integration fixtures or DB.
export default defineConfig({
  envDir: false, // Vite must never discover the checkout’s real .env files.
  server: { hmr: false },
  test: {
    environment: 'node',
    include: ['rehearsal/*.test.ts'],
    pool: 'threads',
    minWorkers: 1,
    maxWorkers: 1,
  },
});
