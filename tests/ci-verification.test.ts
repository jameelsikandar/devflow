import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CI_APPLICATION_URL,
  CI_TEST_URL,
  requireCiDatabase,
  runCiVerification,
} from '../scripts/ci-verification';

const environment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  DATABASE_URL: CI_APPLICATION_URL,
  TEST_DATABASE_URL: CI_TEST_URL,
});

describe('isolated CI database boundary', () => {
  it('accepts only the explicit ephemeral test service and distinct sentinel', () => {
    expect(requireCiDatabase(environment())).toBe(CI_TEST_URL);
  });

  it.each([
    { CI: 'false' },
    { GITHUB_ACTIONS: undefined },
    { RUNNER_ENVIRONMENT: 'self-hosted' },
    { DATABASE_URL: CI_TEST_URL },
    { DATABASE_URL: 'postgresql://private:secret@production.example/devflow' },
    { TEST_DATABASE_URL: undefined },
    { TEST_DATABASE_URL: CI_TEST_URL.replace('devflow_test', 'devflow') },
    { TEST_DATABASE_URL: CI_TEST_URL.replace('5432', '5433') },
    { TEST_DATABASE_URL: CI_TEST_URL.replace('127.0.0.1', 'database.example') },
    { TEST_DATABASE_URL: `${CI_TEST_URL}&host=database.example` },
  ])('rejects unsafe environment overrides before starting a child (%j)', (override) => {
    const run = vi.fn();
    expect(() => runCiVerification('migrate', { ...environment(), ...override }, run)).toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('deploys migrations only, with the child explicitly targeting devflow_test', () => {
    const run = vi.fn(() => ({ status: 0 }));
    runCiVerification('migrate', environment(), run);
    expect(run).toHaveBeenCalledWith(
      process.execPath,
      ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
      expect.objectContaining({ DATABASE_URL: CI_TEST_URL }),
    );
  });

  it('keeps the existing integration guard and blanks inherited provider credentials', () => {
    const run = vi.fn(() => ({ status: 0 }));
    runCiVerification(
      'integration',
      { ...environment(), AI_API_KEY: 'private-fixture', GITHUB_CLIENT_SECRET: 'private-fixture' },
      run,
    );
    expect(run).toHaveBeenCalledWith(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts'],
      expect.objectContaining({
        DATABASE_URL: CI_APPLICATION_URL,
        TEST_DATABASE_URL: CI_TEST_URL,
        AI_API_KEY: '',
        GITHUB_CLIENT_ID: '',
        GITHUB_CLIENT_SECRET: '',
      }),
    );
  });

  it.each([
    { status: 1 },
    { status: null, signal: 'SIGTERM' },
    { status: 0, error: Error('private') },
  ])('fails closed on subprocess failure, signal or startup error', (result) => {
    expect(() => runCiVerification('integration', environment(), () => result)).toThrow(
      'CI integration failed;',
    );
  });

  it('does not leak thrown diagnostics or silently fall back to another database', () => {
    const run = vi.fn(() => {
      throw Error('private connection string');
    });
    expect(() => runCiVerification('migrate', environment(), run)).toThrow(
      'CI migrate could not start; no fallback database is permitted.',
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown or destructive CLI modes', () => {
    const run = vi.fn();
    expect(() => runCiVerification('reset', environment(), run)).toThrow(
      'Choose CI verification mode',
    );
    expect(run).not.toHaveBeenCalled();
  });
});

// Reuse ESLint's existing lockfile-resolved YAML parser; no new dependency is
// installed just to check the CI security contract. YAML is parsed, not regexed.
const eslintRequire = createRequire(require.resolve('eslint/package.json'));
const { load } = eslintRequire('js-yaml') as {
  load: (source: string) => {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: {
      verify: {
        'runs-on': string;
        env: NodeJS.ProcessEnv;
        services: { postgres: { env: Record<string, string>; ports: string[] } };
        steps: { uses?: string; run?: string; with?: Record<string, unknown> }[];
      };
    };
  };
};

describe('GitHub Actions verification contract', () => {
  const source = readFileSync('.github/workflows/ci.yml', 'utf8');
  const workflow = load(source);
  const job = workflow.jobs.verify;

  it('runs on PRs and branch updates without privileged PR triggers or token writes', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(JSON.stringify(workflow)).not.toContain('secrets.');
    expect(job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with).toEqual({
      'persist-credentials': false,
    });
    for (const step of job.steps.filter((item) => item.uses))
      expect(step.uses).toMatch(/^[\w/-]+@[a-f0-9]{40}$/);
  });

  it('keeps pnpm setup aligned with the committed package-manager pin', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { packageManager: string };
    const setup = job.steps.find((step) => step.uses?.startsWith('pnpm/action-setup@'))!;
    expect(`pnpm@${setup.with?.version}`).toBe(manifest.packageManager);
    expect(setup.with?.run_install).toBe(false);
  });

  it('uses the guarded test service and public fixtures without external provider credentials', () => {
    expect(job.services.postgres.env.POSTGRES_DB).toBe('devflow_test');
    expect(job.services.postgres.ports).toEqual(['127.0.0.1:5432:5432']);
    expect(requireCiDatabase({ ...environment(), ...job.env })).toBe(CI_TEST_URL);
    expect(job.env.AI_API_KEY).toBe('');
    expect(job.env.GITHUB_CLIENT_ID).toBe('');
    expect(job.env.GITHUB_CLIENT_SECRET).toBe('');
  });

  it('runs all required checks, guards database operations and never starts a worker', () => {
    const commands = job.steps.flatMap((step) => step.run?.split('\n') ?? []);
    for (const command of [
      'pnpm install --frozen-lockfile',
      'pnpm exec prisma validate',
      'pnpm db:generate',
      'node --import tsx scripts/ci-verification.ts migrate',
      'pnpm format:check',
      'pnpm lint',
      'pnpm typecheck:core',
      'pnpm github:worker:build',
      'pnpm exec vitest run --pool=forks',
      'node --import tsx scripts/ci-verification.ts integration',
      'pnpm build:webpack',
      'pnpm typecheck',
    ])
      expect(commands).toContain(command);
    expect(commands.join('\n')).not.toMatch(
      /migrate reset|db push|db:seed|github:worker(?:\s|$)|\|\| true/,
    );
    expect(source).not.toContain('continue-on-error');
    const cache = job.steps.find((step) => step.uses?.startsWith('actions/cache@'))!;
    expect(cache.with?.path).toBe('${{ steps.pnpm-store.outputs.path }}');
    expect(cache.with?.key).toContain("hashFiles('pnpm-lock.yaml', 'pnpm-workspace.yaml')");
  });
});
