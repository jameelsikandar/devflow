import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { expect, it, vi } from 'vitest';
import { withTransactionAbort } from './transaction-abort';

// Exercise the real Prisma proxy, with an in-memory transaction backend: no DB/socket.
function fixture() {
  const client = new PrismaClient();
  let balance = 0;
  let attempts = 0;
  const transaction = vi.fn(
    async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      const before = { balance, attempts };
      try {
        return await callback({} as Prisma.TransactionClient);
      } catch (error) {
        ({ balance, attempts } = before);
        throw error;
      }
    },
  );
  // Explicit assignment avoids the undefined proxy descriptor used by vi.spyOn.
  client.$transaction = transaction as unknown as typeof client.$transaction;
  return {
    client,
    transaction,
    read: () => ({ balance, attempts }),
    write: () => {
      balance++;
    },
    account: () => {
      attempts++;
    },
  };
}
it('restores the Prisma method before durable retry bookkeeping and after mock cleanup', async () => {
  const f = fixture();
  const fault = new Error('transaction abort');
  const { transactionResult } = await withTransactionAbort(f.client, fault, async () => {
    try {
      await f.client.$transaction(async () => {
        f.write();
        return { state: 'APPLIED' };
      });
    } catch (error) {
      expect(error).toBe(fault);
      expect(f.read()).toEqual({ balance: 0, attempts: 0 });
      await f.client.$transaction(async () => {
        f.account();
      });
    }
  });
  expect(transactionResult).toEqual({ state: 'APPLIED' });
  expect(f.read()).toEqual({ balance: 0, attempts: 1 });
  expect(f.transaction).toHaveBeenCalledTimes(2);
  expect(f.client.$transaction).toBe(f.transaction);
  vi.restoreAllMocks();
  expect(f.client.$transaction).toBe(f.transaction);
  // A later fixture/action still has a genuine transaction method.
  await f.client.$transaction(async () => {
    f.write();
  });
  expect(f.read()).toEqual({ balance: 1, attempts: 1 });
});
it('restores the original method even if the operation propagates an error', async () => {
  const f = fixture();
  const fault = new Error('abort');
  await expect(
    withTransactionAbort(f.client, fault, () =>
      f.client.$transaction(async () => {
        f.write();
      }),
    ),
  ).rejects.toBe(fault);
  expect(f.client.$transaction).toBe(f.transaction);
  expect(f.read()).toEqual({ balance: 0, attempts: 0 });
});
it('fails loudly if a test never reaches a transaction, leaving the client intact', async () => {
  const f = fixture();
  await expect(
    withTransactionAbort(f.client, new Error('abort'), async () => 'no work'),
  ).rejects.toThrow('did not reach');
  expect(f.client.$transaction).toBe(f.transaction);
});
