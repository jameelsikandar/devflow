/* eslint-disable @typescript-eslint/no-require-imports -- Isolated CommonJS worker/preload tooling. */
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const { fork } = require('node:child_process');
const { OperationLane, current, budget } = require('./lifecycle.cjs');
const { Migration } = require('./migration.cjs');
const { bootstrap, socketPath, requestCount } = require('./guard.cjs');
const { command, inventory, canonicalInventory, evidenceLine, insist } = require('./policy.cjs');
let retainedWorkers, migration;
const lane = new OperationLane((status) => {
  fs.writeFileSync('/evidence/operation-state.json', JSON.stringify(status), { mode: 0o600 });
  emit('OPERATION_STATE', { state: status.state, ...(status.code ? { code: status.code } : {}) });
});
function emit(event, values = {}) {
  const line = evidenceLine(event, values);
  fs.appendFileSync('/evidence/events.jsonl', line + '\n', { mode: 0o600 });
  console.log(line);
}
function errorCode(error) {
  return /^REHEARSAL_[A-Z0-9_]{1,100}$/.test(error?.message || '')
    ? error.message
    : 'REHEARSAL_OPERATION_FAILED';
}
async function migrate() {
  const { context, marker, migrationReady } = require('./database.cjs');
  const { db, config } = await context(false);
  const tables = await db.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
  insist(tables.length === 0, 'BOOTSTRAP_REQUIRES_EMPTY_DATABASE');
  // Database/run identifier is strictly validated before interpolation. PostgreSQL
  // identifiers cannot be bound as values. This changes only the fresh fixture DB.
  await db.$executeRawUnsafe(`COMMENT ON DATABASE "${config.database}" IS '${marker(config)}'`);
  migration = new Migration();
  try {
    await migration.run({
      signal: budget()?.signal,
      openLog: async () => {
        const handle = await fs.promises.open('/evidence/migration.log', 'wx', 0o600);
        const stream = fs.createWriteStream(null, { fd: handle.fd, autoClose: false });
        let earlyError;
        stream.on('error', (error) => {
          earlyError = error;
        });
        return {
          attach: (s) => s.pipe(stream, { end: false }),
          onError: (fn) => {
            stream.on('error', fn);
            if (earlyError) fn();
          },
          end: async () => {
            await new Promise((resolve, reject) => {
              stream.once('error', reject);
              stream.end(resolve);
            });
            await handle.close();
          },
        };
      },
      forkChild: () =>
        fork('/work/rehearsal/migration-child.cjs', [], {
          cwd: '/work',
          execArgv: [],
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        }),
    });
  } catch (error) {
    lane.poison('MIGRATION_REQUIRES_REVIEW');
    throw error;
  }
  await migrationReady(db);
  emit('MIGRATIONS_READY', { count: 8 });
}
async function execute(parsed, metadata) {
  const config = bootstrap(parsed.operation === 'configure-inventory');
  if (parsed.operation === 'configure-inventory') {
    inventory(metadata, config.runId);
    fs.writeFileSync('/evidence/resources.json', JSON.stringify(canonicalInventory(metadata)), {
      flag: 'wx',
      mode: 0o400,
    });
    emit('INVENTORY_ACCEPTED', { ok: true });
    return;
  }
  if (parsed.operation === 'verify-isolation') {
    emit('BOOTSTRAP_ISOLATED', { ok: true });
    return;
  }
  if (parsed.operation === 'report') {
    // Failed/unresolved evidence stays readable; never re-label it as a pass.
    return (
      (fs.existsSync('/evidence/operation-state.json')
        ? fs.readFileSync('/evidence/operation-state.json', 'utf8') + '\n'
        : '') +
      (fs.existsSync('/evidence/events.jsonl')
        ? fs.readFileSync('/evidence/events.jsonl', 'utf8')
        : '')
    );
  }
  if (parsed.operation === 'abort-owned') {
    if (migration?.record) await migration.stop();
    if (retainedWorkers) {
      for (const [slot, r] of retainedWorkers.records)
        if (!r.exit) {
          if (r.stopped) retainedWorkers.signal(slot, 'SIGCONT');
          retainedWorkers.signal(slot, 'SIGKILL');
          await retainedWorkers.exited(slot, null, 'SIGKILL');
        }
    }
    emit('OWNED_ABORTED', { ok: true });
    return;
  }
  insist(
    !retainedWorkers || [...retainedWorkers.records.values()].every((r) => r.exit),
    'CHILDREN_STILL_RUNNING',
  );
  insist(!fs.existsSync('/evidence/http-violation') && requestCount() === 0, 'HTTP_ATTEMPT');
  if (parsed.operation === 'migrate-disposable') return migrate();
  const ctx = await require('./database.cjs').context();
  if (parsed.operation === 'create-fixtures') {
    await require('./fixtures.cjs').baseline(ctx);
    emit('FIXTURES_READY', { ok: true });
    return;
  }
  const { Workers } = require('./processes.cjs');
  retainedWorkers = new Workers(emit);
  try {
    await require('./scenarios.cjs').runScenario(ctx, parsed.scenario, retainedWorkers, emit);
    insist(!fs.existsSync('/evidence/http-violation') && requestCount() === 0, 'HTTP_ATTEMPT');
  } finally {
    // A fresh cleanup budget permits drain after cancellation, but never new fixture work.
    try {
      await current.run(undefined, () => retainedWorkers.drain());
    } catch (error) {
      lane.poison('OWNED_WORK_UNRESOLVED');
      throw error;
    }
  }
}
function serve() {
  bootstrap(true); // Deliberately no Prisma, DB, fixtures or worker import here.
  if (fs.existsSync('/evidence/operation-state.json')) {
    try {
      const prior = JSON.parse(fs.readFileSync('/evidence/operation-state.json', 'utf8'));
      if (prior.state !== 'COMPLETED') lane.poison('PREVIOUS_OPERATION_REQUIRES_REVIEW');
    } catch {
      lane.poison('PREVIOUS_OPERATION_REQUIRES_REVIEW');
    }
  }
  const socket = socketPath();
  insist(!fs.existsSync(socket), 'SOCKET_ALREADY_EXISTS');
  const server = net.createServer((client) => {
    let input = '',
      consumed = false;
    client.on('error', () => {});
    client.on('data', async (chunk) => {
      if (consumed) return;
      input += chunk.toString();
      if (Buffer.byteLength(input) > 65536) {
        consumed = true;
        client.destroy();
        return;
      }
      if (!input.includes('\n')) return;
      consumed = true;
      let replied = false;
      const disconnected = new AbortController();
      client.once('close', () => {
        if (!replied) disconnected.abort();
      });
      try {
        const message = JSON.parse(input);
        insist(Array.isArray(message.argv), 'COMMAND');
        const parsed = command(message.argv);
        insist(parsed.operation !== 'serve', 'NESTED_SERVER');
        const diagnostics = ['report', 'abort-owned'].includes(parsed.operation);
        insist(diagnostics || (!lane.active && !lane.blocked), 'OPERATION_LOCKED');
        if (parsed.operation === 'abort-owned')
          insist(!lane.active || lane.blocked, 'OPERATION_LOCKED');
        const report = diagnostics
          ? await execute(parsed, message.inventory)
          : await lane.run(() => execute(parsed, message.inventory), {
              signal: disconnected.signal,
            });
        if (disconnected.signal.aborted || client.destroyed)
          throw Error('REHEARSAL_CLIENT_DISCONNECTED');
        if (parsed.operation === 'run')
          emit('SCENARIO_COMPLETE', { scenario: parsed.scenario, ok: true });
        replied = true;
        client.end(JSON.stringify({ ok: true, ...(report ? { report } : {}) }) + '\n');
      } catch (error) {
        const code = errorCode(error);
        emit('OPERATION_FAILED', { code: code.slice(0, 80) });
        replied = true;
        client.end(JSON.stringify({ ok: false, code }) + '\n');
      }
    });
  });
  server.listen(socket, () => {
    fs.chmodSync(socket, 0o600);
    console.log(evidenceLine('CONTROLLER_READY'));
  });
  server.on('error', () => {
    console.error('REHEARSAL_SOCKET_FAILED');
    process.exitCode = 1;
  });
  // Do not install an automatic process/data/resource cleanup handler. A controller
  // shutdown must follow explicit stop/abort and host resource validation.
}
function client(argv) {
  const parsed = command(argv);
  bootstrap(parsed.operation === 'configure-inventory');
  const metadata =
    parsed.operation === 'configure-inventory' ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
  if (metadata) inventory(metadata, process.env.REHEARSAL_RUN_ID);
  const socket = net.createConnection(socketPath());
  let output = '';
  socket.setTimeout(360000, () => socket.destroy(new Error('REHEARSAL_CLIENT_TIMEOUT')));
  socket.on('connect', () =>
    socket.write(
      JSON.stringify({ argv, ...(metadata ? { inventory: canonicalInventory(metadata) } : {}) }) +
        '\n',
    ),
  );
  socket.on('data', (chunk) => {
    output += chunk.toString();
  });
  socket.on('end', () => {
    try {
      const response = JSON.parse(output);
      if (response.report) process.stdout.write(response.report);
      if (!response.ok) {
        console.error(response.code);
        process.exitCode = 1;
      } else console.log(evidenceLine('COMMAND_COMPLETE', { ok: true }));
    } catch {
      console.error('REHEARSAL_INVALID_RESPONSE');
      process.exitCode = 1;
    }
  });
  socket.on('error', () => {
    console.error('REHEARSAL_CONTROLLER_UNAVAILABLE');
    process.exitCode = 1;
  });
}
if (require.main === module) {
  try {
    const parsed = command(process.argv.slice(2));
    if (parsed.operation === 'serve') serve();
    else client(process.argv.slice(2));
  } catch {
    console.error('REHEARSAL_PREFLIGHT_FAILED');
    process.exitCode = 1;
  }
}
module.exports = { errorCode };
