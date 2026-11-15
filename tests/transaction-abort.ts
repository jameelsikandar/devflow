import type { Prisma, PrismaClient } from '@prisma/client';

type TransactionCallback = (tx: Prisma.TransactionClient) => Promise<unknown>;
type TransactionOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

/**
 * Abort one real interactive transaction after its callback has written, before commit.
 * Prisma's proxy reports an undefined value in its method property descriptor, so
 * reflection-based spies cannot safely provide fallback or restore this method.
 */
export async function withTransactionAbort<T>(
  client: Pick<PrismaClient, '$transaction'>,
  error: Error,
  operation: () => Promise<T>,
) {
  const original = client.$transaction;
  let intercepted = false;
  let transactionResult: unknown;
  const injected = (callback: TransactionCallback, options?: TransactionOptions) => {
    // Failure bookkeeping must use a genuine new transaction, not the injection.
    client.$transaction = original;
    intercepted = true;
    return original.call(
      client,
      async (tx) => {
        transactionResult = await callback(tx);
        throw error;
      },
      options,
    );
  };
  client.$transaction = injected as typeof client.$transaction;
  try {
    const result = await operation();
    if (!intercepted) throw new Error('Fault injection did not reach an interactive transaction');
    return { result, transactionResult };
  } finally {
    // Also restore on operation errors and failed assertions; do not use mockRestore.
    client.$transaction = original;
  }
}
