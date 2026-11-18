import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
// Source inspection only; none of the entry points below are imported/executed.
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
it('builds explicit source paths with new dependencies and a new generated client', () => {
  const docker = source('Worker.Dockerfile');
  expect(docker).toContain('COPY src ./src');
  expect(docker).not.toMatch(/COPY\s+\.\s|COPY.*node_modules|--env-file/);
  expect(docker).toContain('pnpm install --frozen-lockfile');
  expect(docker).toContain('pnpm db:generate');
  expect(docker).toContain('USER node');
  expect(docker).toContain('"serve"');
  expect(source('Worker.Dockerfile.dockerignore')).toContain('**/.env.*');
  expect(source('vitest.config.ts')).toContain('envDir: false');
});
it('validates environment before compiling/loading any application entry point', () => {
  const child = source('child.cjs');
  expect(child.indexOf('const config = bootstrap()')).toBeLessThan(
    child.indexOf("require('./database.cjs')"),
  );
  expect(child).toContain("require('/work/.worker/scripts/github-worker.js')");
  expect(source('database.cjs')).toContain(
    'bootstrap(); // Before loading even the Prisma constructor.',
  );
  expect(source('cli-guard.cjs')).toContain('bootstrap()');
});
it('keeps actual completion and lease renewal in the production path', () => {
  const child = source('child.cjs');
  expect(child).toContain("await gate('publish')");
  expect(child).toContain('await original(lease, publish)');
  expect(child).toContain('await renew(lease, 30)');
  expect(child).toContain('await fail(lease,');
  const scenarios = source('scenarios.cjs');
  expect(scenarios).toContain('SELECT clock_timestamp() AS now');
  expect(scenarios).not.toMatch(/leaseExpiresAt:\s*new Date|heartbeatAt:\s*new Date/);
});
it('has no reset, seed, external PID kill, resource deletion or automatic worker at controller startup', () => {
  const controller = source('controller.cjs');
  expect(controller).not.toMatch(/migrate.*reset|db push|\.deleteMany\(|process\.kill\(/);
  expect(source('processes.cjs')).not.toContain('process.kill(');
  expect(controller).toContain('bootstrap(true); // Deliberately no Prisma');
  expect(source('resources.cjs')).toContain('deletionAuthorized: false');
});

it('keeps owner-supplied provenance unapproved and checks package integrity', () => {
  const p = JSON.parse(source('provenance.json'));
  expect(p.approved).toBe(false);
  expect(p.nodeImage).toMatch(/^node:22-bookworm@sha256:[a-f0-9]{64}$/);
  expect(p.postgresImage).toMatch(/^postgres:18-alpine@sha256:[a-f0-9]{64}$/);
  expect(p.platform).toBe('linux/amd64');
  expect(Buffer.from(p.pnpmIntegrity.slice('sha512-'.length), 'base64')).toHaveLength(64);
  expect(p.reviewEvidence).toContain('Owner-reported');
  const docker = source('Worker.Dockerfile');
  expect(docker).toContain('ARG NODE_IMAGE');
  expect(docker).toContain('verify-provenance.cjs --tarball');
  expect(source('verify-provenance.cjs')).toContain("createHash('sha512')");
});
it('uses a main-module migration guardian and no arbitrary PID signaling', () => {
  const guardian = source('migration-child.cjs');
  expect(guardian.indexOf("require('./guard.cjs').bootstrap()")).toBeLessThan(
    guardian.indexOf("require('node:module').runMain"),
  );
  for (const file of ['migration-child.cjs', 'migration.cjs', 'descendants.cjs'])
    expect(source(file)).not.toContain('process.kill(');
  expect(source('entrypoint.sh')).toContain('unset NODE_OPTIONS NODE_PATH');
});
it('keeps syntax failures fatal and does not claim untested crash windows', () => {
  expect(source('README.md')).toContain('node --check "$file" || exit 1');
  expect(source('README.md')).toContain('Mid-transaction OS kill');
  expect(source('controller.cjs')).toContain('PREVIOUS_OPERATION_REQUIRES_REVIEW');
  expect(source('database.cjs')).toContain('DATABASE_TIMEOUTS');
});
