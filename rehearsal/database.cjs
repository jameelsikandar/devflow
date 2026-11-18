/* eslint-disable @typescript-eslint/no-require-imports -- Isolated CommonJS worker/preload tooling. */
'use strict';
// This module has no application imports at load time. Every entry validates first.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { bootstrap } = require('./guard.cjs');
const { insist } = require('./policy.cjs');
const { guardedDatabase } = require('./lifecycle.cjs');
let wrapped = false;
const app = (name) => {
  bootstrap();
  insist(
    [
      'db',
      'crypto',
      'github-processing',
      'github-operational-health',
      'github-repositories',
      'github-workflows',
      'github-worker-health',
      'github-event-handlers',
    ].includes(name),
    'MODULE',
  );
  const loaded = require(`/work/.worker/src/lib/server/${name}.js`);
  if (name === 'db' && !wrapped) {
    loaded.db = guardedDatabase(loaded.db);
    wrapped = true;
  }
  return loaded;
};
function marker(config) {
  return `devflow-worker-rehearsal:${config.runId}`;
}
async function identity(db, config, requireMarker = true) {
  const [server] =
    await db.$queryRaw`SELECT current_database() AS name,current_user AS role,current_setting('server_version_num')::int AS version`;
  insist(
    server.name === config.database &&
      server.role === 'worker_fixture_admin' &&
      server.version >= 180000 &&
      server.version < 190000,
    'SERVER_IDENTITY',
  );
  const [limits] = await db.$queryRaw`SELECT current_setting('statement_timeout') AS statement,
    current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`;
  insist(
    limits.statement === '8s' && limits.lock === '3s' && limits.idle === '12s',
    'DATABASE_TIMEOUTS',
  );
  const databases =
    await db.$queryRaw`SELECT datname AS name,shobj_description(oid,'pg_database') AS comment FROM pg_database`;
  insist(
    databases.every((d) =>
      ['postgres', 'template0', 'template1', config.database].includes(d.name),
    ),
    'FOREIGN_DATABASE',
  );
  if (requireMarker)
    insist(
      databases.find((d) => d.name === config.database)?.comment === marker(config),
      'DATABASE_OWNER',
    );
}
async function context(requireMarker = true) {
  const config = bootstrap(); // Before loading even the Prisma constructor.
  const { db } = app('db');
  await identity(db, config, requireMarker);
  return { db, config, app };
}
async function migrationReady(db) {
  const expected = fs
    .readdirSync('/work/prisma/migrations')
    .filter((n) => /^\d{12}_/.test(n))
    .sort();
  insist(expected.length === 8, 'MIGRATION_INVENTORY');
  const rows =
    await db.$queryRaw`SELECT migration_name,checksum,finished_at,rolled_back_at FROM public."_prisma_migrations"`;
  insist(rows.length === expected.length, 'MIGRATION_COUNT');
  for (const name of expected) {
    const row = rows.find((r) => r.migration_name === name);
    const checksum = crypto
      .createHash('sha256')
      .update(fs.readFileSync(`/work/prisma/migrations/${name}/migration.sql`))
      .digest('hex');
    insist(row?.finished_at && !row.rolled_back_at && row.checksum === checksum, 'MIGRATION_STATE');
  }
}
module.exports = { app, context, identity, marker, migrationReady };
