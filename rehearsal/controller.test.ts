import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url);
// Importing these exports does not spawn children, install guards or open sockets.
const { supervise } = require('./processes.cjs');
const { errorCode } = require('./controller.cjs');
it('bounds restarts and applies backoff with pure injected attempts', async () => {
  const attempts: number[] = [],
    waits: number[] = [],
    restarts: number[] = [];
  const result = await supervise(
    async (i: number) => {
      attempts.push(i);
      return { code: null, signal: 'SIGKILL' };
    },
    async (ms: number) => {
      waits.push(ms);
    },
    (i: number) => restarts.push(i),
  );
  expect(attempts).toEqual([0, 1, 2]);
  expect(waits).toEqual([2000, 2000]);
  expect(restarts).toEqual([1, 2]);
  expect(result.exhausted).toBe(true);
});
it('never restarts a graceful zero exit', async () => {
  const result = await supervise(
    async () => ({ code: 0, signal: null }),
    () => {
      throw Error('unexpected wait');
    },
    () => {
      throw Error('unexpected restart');
    },
  );
  expect(result).toMatchObject({ restarts: 0, exhausted: false });
});
it('recovers once and stops after the successful replacement', async () => {
  const result = await supervise(
    async (i: number) => (i ? { code: 0, signal: null } : { code: 1, signal: null }),
    async () => {},
    () => {},
  );
  expect(result).toMatchObject({ restarts: 1, exhausted: false });
});
it('reports static error codes without database/provider diagnostics', () => {
  expect(errorCode(Error('password=private payload'))).toBe('REHEARSAL_OPERATION_FAILED');
  expect(errorCode(Error('REHEARSAL_DATABASE_OWNER'))).toBe('REHEARSAL_DATABASE_OWNER');
});
