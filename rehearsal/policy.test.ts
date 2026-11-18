import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
// These modules have no entry-point side effects. No bootstrap, fork, Docker,
// application module, database, HTTP guard installation or real env access here.
const p = require('./policy.cjs');
const { main } = require('./resources.cjs');
const { collect } = require('./inventory.cjs');
const { inspectFilesystem, installDeny } = require('./guard.cjs');
const run = '20261118T000000Z_1234abcd';
const n = p.names(run);
function env() {
  return {
    REHEARSAL_RUN_ID: run,
    REHEARSAL_DATABASE: n.database,
    DATABASE_URL: p.databaseUrl(run),
    NODE_ENV: 'test',
    CHECKPOINT_DISABLE: '1',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    TOKEN_ENCRYPTION_KEY: p.FIXTURE_KEY,
    APP_URL: 'http://127.0.0.1:1',
    GITHUB_DEMO: 'false',
    AI_API_KEY: '',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
  };
}
const { fixtureResources: resources } = require('./test-fixtures.cjs');
describe('closed rehearsal target and command policy', () => {
  it('accepts only the exact synthetic connection on the private alias', () => {
    expect(p.environment(env()).database).toBe(n.database);
    expect(p.databaseUrl(run)).not.toContain('/devflow?');
  });
  it.each([
    'devflow',
    'devflow_test',
    'devflow_recovery_20261117T230002Z_b468b9ee8567',
    '../devflow',
    '',
  ])('rejects protected/non-run name %s', (database) => {
    expect(() => p.environment({ ...env(), REHEARSAL_DATABASE: database })).toThrow(
      'DATABASE_NAME',
    );
  });
  it.each(['localhost', '127.0.0.1', 'host.docker.internal', 'worker-pg.invalid'])(
    'rejects host override %s',
    (host) => {
      expect(() =>
        p.environment({ ...env(), DATABASE_URL: p.databaseUrl(run).replace('worker-pg', host) }),
      ).toThrow('DATABASE_URL');
    },
  );
  it.each(['AI_API_KEY', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY'])(
    'rejects real configuration in %s',
    (key) => {
      expect(() => p.environment({ ...env(), [key]: 'not-synthetic' })).toThrow();
    },
  );
  it.each([
    'NODE_OPTIONS',
    'PGHOST',
    'DOTENV_CONFIG_PATH',
    'PRISMA_SCHEMA_ENGINE_BINARY',
    'TEST_DATABASE_URL',
    'AWS_SECRET_ACCESS_KEY',
  ])('rejects inherited %s', (key) => {
    expect(() => p.environment({ ...env(), [key]: 'forbidden' })).toThrow();
  });
  it.each(Object.entries(p.SCENARIOS))('requires exact approval for %s', (scenario, scope) => {
    expect(p.command(['run', scenario, '--approve', scope, '--retain']).scenario).toBe(scenario);
    expect(() => p.command(['run', scenario])).toThrow('APPROVAL');
    expect(() =>
      p.command(['run', scenario, '--approve', scope, '--retain', '--pid', '1']),
    ).toThrow();
  });
  it('has no arbitrary URL, PID, task, cleanup or shell command interface', () => {
    for (const command of ['delete', 'cleanup', 'exec', 'kill', 'seed', 'reset'])
      expect(() => p.command([command])).toThrow();
    expect(() => p.names('devflow')).toThrow();
    expect(p.command(['abort-owned', '--approve', 'faults']).operation).toBe('abort-owned');
  });
});
describe('resource ownership and cleanup validation', () => {
  it('accepts the dedicated inventory and redacts unknown fields', () => {
    const v = resources();
    Object.assign(v, { secret: 'DO_NOT_REPORT' });
    v.resources.controller.env = 'DO_NOT_REPORT';
    expect(JSON.stringify(main(['validate-start', run], JSON.stringify(v)))).not.toContain(
      'DO_NOT_REPORT',
    );
  });
  it.each(['network', 'postgres', 'controller', 'data', 'evidence'])(
    'rejects foreign %s',
    (key) => {
      const v = resources();
      v.resources[key].labels['devflow.rehearsal'] = 'foreign';
      expect(() => p.inventory(v, run)).toThrow(
        ['data', 'evidence'].includes(key) ? 'VOLUME_OWNER' : 'RESOURCE_OWNER',
      );
    },
  );
  it.each([
    'network',
    'ports',
    'privileged',
    'bind',
    'extra-network',
    'root',
    'user',
    'extra-volume',
  ])('fails closed for %s', (kind) => {
    const v = resources();
    const c = v.resources.controller;
    if (kind === 'network') v.resources.network.internal = false;
    if (kind === 'ports') c.publishedPorts = 1;
    if (kind === 'privileged') c.privileged = true;
    if (kind === 'bind') c.mounts[0].type = 'bind';
    if (kind === 'extra-network') c.networks.push('bridge');
    if (kind === 'root') c.readOnlyRootfs = false;
    if (kind === 'user') c.user = 'root';
    if (kind === 'extra-volume') c.mounts.push({ ...c.mounts[0] });
    expect(() => p.inventory(v, run)).toThrow();
  });
  it('requires stopped owned resources but never authorizes deletion', () => {
    const v = resources();
    expect(() =>
      main(['validate-cleanup', run], JSON.stringify({ original: resources(), current: v })),
    ).toThrow('CLEANUP_RUNNING_PROCESS');
    v.resources.controller.running = false;
    v.resources.postgres.running = false;
    expect(
      main(['validate-cleanup', run], JSON.stringify({ original: resources(), current: v }))
        .deletionAuthorized,
    ).toBe(false);
  });
  it('rejects unexpected network peers and a missing database alias', () => {
    const v = resources();
    v.resources.network.peers.push('foreign-forwarder');
    expect(() => p.inventory(v, run)).toThrow('NETWORK_PEERS');
    v.resources.network.peers = [n.postgres, n.controller];
    v.resources.postgres.databaseAlias = false;
    expect(() => p.inventory(v, run)).toThrow('DATABASE_ALIAS');
  });
  it('validates stopped peers and rejects replaced resource IDs', () => {
    const original = resources(),
      current = resources();
    current.resources.controller.running = false;
    current.resources.postgres.running = false;
    current.resources.network.peers = [];
    expect(main(['validate-cleanup', run], JSON.stringify({ original, current })).validated).toBe(
      true,
    );
    current.resources.controller.id = 'c'.repeat(64);
    expect(() => main(['validate-cleanup', run], JSON.stringify({ original, current }))).toThrow(
      'RESOURCE_REPLACED',
    );
  });
  it('collector requests only selected Docker fields, never credentials or full inspect', () => {
    const v = resources();
    const formats: string[] = [];
    const output = collect(
      run,
      (_type: string, name: string, format: string) => {
        formats.push(format);
        const key = Object.keys(v.resources).find((k) => v.resources[k].name === name)!;
        const r = v.resources[key];
        if (format.includes('Labels')) return r.labels;
        if (key === 'network')
          return {
            id: r.id,
            internal: true,
            containers: { a: { Name: n.postgres }, b: { Name: n.controller } },
          };
        if (['data', 'evidence'].includes(key)) return r;
        return {
          ...r,
          networks: { [n.network]: { Aliases: ['worker-pg'] } },
          ports: {},
          mounts: r.mounts.map(
            (m: { type: string; source: string; target: string; writable: boolean }) => ({
              Type: m.type,
              Name: m.source,
              Destination: m.target,
              RW: m.writable,
            }),
          ),
        };
      },
      false,
      v.storage,
    );
    expect(output.runId).toBe(run);
    expect(formats.every((f) => !f.includes('.Env') && f !== '{{json .}}')).toBe(true);
  });
});
describe('pre-import filesystem validation using only synthetic IO', () => {
  function fake(files: string[] = [], mount = '1 0 0:1 / / ro - overlay overlay ro') {
    return {
      existsSync: (name: string) => name === '/.dockerenv',
      realpathSync: () => '/work',
      readdirSync: () => files,
      readFileSync: (name: string) =>
        name.includes('image.json')
          ? JSON.stringify({ version: 1, root: '/work', nodeMajor: 22 })
          : mount,
    };
  }
  const runtime = { cwd: () => '/work', node: '22.23.1', uid: () => 1000 };
  it('accepts a clean immutable non-root image', () =>
    expect(inspectFilesystem(fake(), runtime).version).toBe(1));
  it.each(['.env', '.env.local', '.env.production'])(
    'rejects %s by filename without reading it',
    (file) => expect(() => inspectFilesystem(fake([file]), runtime)).toThrow('ENV_FILE_PRESENT'),
  );
  it('rejects writable root, root user and mounted source', () => {
    expect(() =>
      inspectFilesystem(fake([], '1 0 0:1 / / rw - overlay overlay rw'), runtime),
    ).toThrow('ROOT_WRITABLE');
    expect(() => inspectFilesystem(fake(), { ...runtime, uid: () => 0 })).toThrow('NONROOT');
    expect(() =>
      inspectFilesystem(fake([], '1 0 0:1 / /work ro - overlay overlay ro'), runtime),
    ).toThrow('HOST_SOURCE_MOUNT');
    expect(() => inspectFilesystem(fake([], ''), runtime)).toThrow('ROOT_MOUNT_MISSING');
  });
});
describe('sanitized evidence and owned signals', () => {
  it('never serializes tokens, payloads, URLs or record identifiers', () => {
    const line = p.evidenceLine('LEASE', {
      attempts: 1,
      state: 'PROCESSING',
      leaseToken: 'SECRET',
      DATABASE_URL: 'SECRET',
      payload: { secret: 'SECRET' },
    });
    expect(JSON.parse(line)).toEqual({
      component: 'worker-rehearsal',
      event: 'LEASE',
      attempts: 1,
      state: 'PROCESSING',
    });
  });
  it('rejects free-form sensitive diagnostic strings', () =>
    expect(() => p.evidenceLine('ERROR', { code: 'https://private.invalid' })).toThrow());
  it('requires owned child identity, capability and live lifecycle before signaling', () => {
    const child = { pid: 123 };
    const record = { child, pid: 123, token: 'capability', exit: null };
    expect(() => p.ownedChild(record, child, 'capability', 'SIGTERM')).not.toThrow();
    expect(() => p.ownedChild(record, { pid: 123 }, 'capability', 'SIGTERM')).toThrow();
    expect(() => p.ownedChild(record, child, 'wrong', 'SIGKILL')).toThrow();
    expect(() =>
      p.ownedChild({ ...record, exit: { code: 0 } }, child, 'capability', 'SIGTERM'),
    ).toThrow();
    expect(() => p.ownedChild(record, child, 'capability', 'SIGUSR1')).toThrow();
  });
});

describe('outbound rejection using fake transports only', () => {
  it('blocks fetch, HTTP, HTTPS, HTTP2 and TCP while allowing only owned control IPC', () => {
    let violations = 0;
    const root = { fetch: () => 'unexpected' };
    const transports = [
      { request: () => {}, get: () => {} },
      { request: () => {}, get: () => {} },
      { connect: () => {} },
    ];
    const prototype = { connect: (...args: unknown[]) => args };
    installDeny({
      root,
      transports,
      prototype,
      controlSocket: () => '/tmp/owned.sock',
      record: () => violations++,
    });
    expect(() => root.fetch()).toThrow('HTTP_FORBIDDEN');
    for (const t of transports)
      for (const f of Object.values(t)) expect(() => f()).toThrow('HTTP_FORBIDDEN');
    expect(() => prototype.connect({ host: 'worker-pg', port: 443 })).toThrow('HTTP_FORBIDDEN');
    expect(() => prototype.connect('/tmp/foreign.sock')).toThrow('HTTP_FORBIDDEN');
    expect(prototype.connect({ path: '/tmp/owned.sock' })).toEqual([{ path: '/tmp/owned.sock' }]);
    expect(prototype.connect([{ path: '/tmp/owned.sock' }])).toEqual([
      [{ path: '/tmp/owned.sock' }],
    ]);
    expect(violations).toBe(8);
  });
});
