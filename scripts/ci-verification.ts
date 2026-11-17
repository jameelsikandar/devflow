/** CI-only entry point. Never load .env or infer a database from developer settings. */
import { spawnSync } from 'node:child_process';
import { requireTestDatabase } from '../tests/database-config';

// Public disposable fixtures, not application credentials. The application URL
// is deliberately unreachable; only the test service is allowed to receive SQL.
export const CI_APPLICATION_URL =
  'postgresql://devflow_ci:ci_fixture_only@127.0.0.1:1/devflow_ci_unused?schema=public';
export const CI_TEST_URL =
  'postgresql://devflow_ci:ci_fixture_only@127.0.0.1:5432/devflow_test?schema=public';

export function requireCiDatabase(environment: NodeJS.ProcessEnv) {
  if (
    environment.CI !== 'true' ||
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.RUNNER_ENVIRONMENT !== 'github-hosted'
  )
    throw new Error('CI database commands require a disposable GitHub-hosted runner.');
  // Exact matching also excludes host/socket overrides in query parameters,
  // hosted databases, local port 5433 and database-name aliases.
  if (
    environment.DATABASE_URL !== CI_APPLICATION_URL ||
    environment.TEST_DATABASE_URL !== CI_TEST_URL
  )
    throw new Error('CI database configuration does not match the isolated PostgreSQL service.');
  return requireTestDatabase(environment.DATABASE_URL, environment.TEST_DATABASE_URL).href;
}

type Run = (
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
) => { status: number | null; error?: unknown; signal?: string | null };

const runChild: Run = (executable, args, environment) =>
  spawnSync(executable, args, { env: environment, stdio: 'inherit' });

export function runCiVerification(
  mode: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  run: Run = runChild,
) {
  if (mode !== 'migrate' && mode !== 'integration')
    throw new Error('Choose CI verification mode: migrate or integration.');
  const testUrl = requireCiDatabase(environment);
  const childEnvironment = {
    ...environment,
    AI_API_KEY: '',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    GITHUB_DEMO: 'false',
    TEST_DATABASE_URL: testUrl,
    // Integration configuration validates the two distinct database names,
    // then swaps DATABASE_URL before importing any database-backed tests.
    DATABASE_URL: mode === 'migrate' ? testUrl : CI_APPLICATION_URL,
  };
  const args =
    mode === 'migrate'
      ? ['node_modules/prisma/build/index.js', 'migrate', 'deploy']
      : ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts'];
  let result: ReturnType<Run>;
  try {
    result = run(process.execPath, args, childEnvironment);
  } catch {
    throw new Error(`CI ${mode} could not start; no fallback database is permitted.`);
  }
  if (result.error || result.signal || result.status !== 0)
    throw new Error(`CI ${mode} failed; inspect the preceding isolated-service check output.`);
}

if (typeof require !== 'undefined' && require.main === module) {
  try {
    runCiVerification(process.argv[2]);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
