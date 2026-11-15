import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { requireTestDatabase } from '../tests/database-config';

function main() {
  const applicationUrl = process.env.DATABASE_URL;
  if (!applicationUrl) throw new Error('Configure DATABASE_URL in .env first.');
  const candidate = new URL(applicationUrl);
  candidate.pathname = `${candidate.pathname}_test`;
  const configured = process.env.TEST_DATABASE_URL;
  const test = requireTestDatabase(applicationUrl, configured || candidate.href);
  const databaseName = decodeURIComponent(test.pathname.slice(1));
  const connectionEnv = {
    ...process.env,
    PGHOST: test.hostname,
    PGPORT: test.port || '5432',
    PGUSER: decodeURIComponent(test.username),
    PGPASSWORD: decodeURIComponent(test.password),
    PGDATABASE: 'postgres',
    PGCONNECT_TIMEOUT: '5',
    ...(test.searchParams.has('sslmode') ? { PGSSLMODE: test.searchParams.get('sslmode')! } : {}),
  };
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { env: connectionEnv, encoding: 'utf8' });
    if (result.error) throw new Error(`${command} is unavailable: ${result.error.message}`);
    if (result.status !== 0)
      throw new Error(
        `${command} failed (exit ${result.status}): ${result.stderr.trim() || 'No diagnostic returned. Check PostgreSQL access and socket permissions.'}`,
      );
    return result.stdout.trim();
  };
  // Name is validated by requireTestDatabase before interpolation. No DROP,
  // reset, force-create, schema push or application database writes occur here.
  const exists = run('psql', [
    '-X',
    '-A',
    '-t',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `SELECT 1 FROM pg_database WHERE datname = '${databaseName}'`,
  ]);
  if (exists !== '1') {
    run('createdb', ['--maintenance-db=postgres', '--', databaseName]);
    console.log(`Created isolated database ${databaseName}.`);
  } else console.log(`Using existing isolated database ${databaseName}; no data reset.`);
  if (!configured) {
    // Persist only after successful database access/creation. .env is ignored.
    appendFileSync(
      '.env',
      `\n# Isolated integration and browser verification database\nTEST_DATABASE_URL=${JSON.stringify(test.href)}\n`,
      { mode: 0o600 },
    );
    console.log('Saved TEST_DATABASE_URL to .env (connection credentials omitted from output).');
  }
  const migrate = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    {
      env: { ...process.env, DATABASE_URL: test.href },
      stdio: 'inherit',
    },
  );
  if (migrate.error || migrate.status !== 0)
    throw new Error('Test database migration failed. No database was reset.');
  console.log('Isolated test database is ready.');
}
try {
  main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
