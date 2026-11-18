/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Prisma guardian. */
'use strict';
function main() {
  require('./guard.cjs').bootstrap();
  const { insist } = require('./policy.cjs');
  insist(!!process.send && process.connected, 'OWNED_IPC_REQUIRED');
  const fs = require('node:fs'),
    cp = require('node:child_process');
  const { Descendants, procTree } = require('./descendants.cjs');
  const registry = new Descendants(procTree(fs));
  const spawn = cp.ChildProcess.prototype.spawn;
  // Includes execa/execFile/spawn through Node's lowest JS spawn entry point.
  cp.ChildProcess.prototype.spawn = function (...args) {
    insist(!registry.cancelling, 'MIGRATION_CANCELLED');
    const result = spawn.apply(this, args);
    registry.add(this, procTree(fs).find((p) => p.pid === this.pid)?.start);
    return result;
  };
  let closing = false,
    requestedCode;
  const hardExit = process.exit.bind(process);
  const finish = async (code, cancel = false) => {
    if (cancel) {
      requestedCode = 1;
      try {
        registry.terminate();
      } catch {
        process.channel?.ref();
        if (process.connected) process.send({ type: 'migration-unresolved' });
        else setInterval(() => {}, 1000);
        return;
      }
    }
    if (closing) return;
    closing = true;
    requestedCode = code;
    process.channel?.ref();
    const until = Date.now() + 40000;
    try {
      while (!registry.inspect(procTree(fs), process.pid)) {
        if (Date.now() > until) throw Error('UNRESOLVED');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (process.connected)
        process.send({ type: 'migration-terminal', code: requestedCode, descendants: 0 }, () => {
          if (process.connected) process.disconnect();
          hardExit(requestedCode);
        });
      else hardExit(requestedCode);
    } catch {
      if (process.connected) process.send({ type: 'migration-unresolved' });
      else setInterval(() => {}, 1000);
      // Remain alive with IPC referenced. No arbitrary PID/group signals or success.
    }
  };
  process.exit = (code) => {
    void finish(Number(code ?? process.exitCode ?? 0), Number(code ?? 0) !== 0);
  };
  process.on('message', (m) => {
    if (m?.type === 'cancel') void finish(1, true);
  });
  process.on('disconnect', () => {
    void finish(1, true);
  });
  process.on('SIGTERM', () => {
    void finish(1, true);
  });
  process.on('uncaughtException', () => {
    void finish(1, true);
  });
  process.on('unhandledRejection', () => {
    void finish(1, true);
  });
  process.once('beforeExit', () => {
    void finish(Number(process.exitCode ?? 0));
  });
  process.argv = [
    process.execPath,
    '/work/node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
  ];
  // Prisma 6.19 gates its CLI on require.main === module. Run as the real main,
  // after guard/ownership hooks, rather than merely requiring an inert CLI module.
  try {
    require('node:module').runMain('/work/node_modules/prisma/build/index.js');
  } catch {
    void finish(1, true);
  }
  if (!closing) process.channel?.unref();
}
if (require.main === module) {
  try {
    main();
  } catch {
    console.error('REHEARSAL_MIGRATION_GUARD_FAILED');
    process.exitCode = 1;
    process.disconnect?.();
  }
}
