import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
// All injected Docker, filesystem, DB and process objects are fakes. No spawn,
// bootstrap, environment reads, HTTP, resource mutation or application imports.
const { fixtureStorage, fixturePins, run } = require('./test-fixtures.cjs');
const { volume, receipt, absent, provenance } = require('./storage-policy.cjs');
const { inspectEmpty, admit } = require('./storage-probe.cjs');
const { prepare, beforePostgres } = require('./storage-admit.cjs');
const { OperationLane, guardedDatabase, current } = require('./lifecycle.cjs');
const { Workers, until } = require('./processes.cjs');
const { Migration } = require('./migration.cjs');
const { Descendants } = require('./descendants.cjs');
const assertions = require('./assertions.cjs');
afterEach(() => vi.useRealTimers());
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 123,
    connected: true,
    stdout: {},
    stderr: {},
    send: vi.fn(),
    kill: vi.fn(() => true),
  });
}
describe('pre-PostgreSQL storage admission', () => {
  it.each(['bind', 'remote', 'reused', 'unknown'])(
    'rejects %s backing before any probe write',
    (kind) => {
      const s = fixtureStorage();
      const m = s.volumes.data;
      if (kind === 'bind') m.optionCount = 1;
      if (kind === 'remote') m.driver = 'nfs';
      if (kind === 'reused') m.createdAt = '2026-11-17T00:00:00Z';
      if (kind === 'unknown') delete m.driver;
      expect(() =>
        volume(m, run, 'data', Date.parse(s.startedAt), Date.parse(s.admittedAt)),
      ).toThrow();
    },
  );
  it('requires Docker-generated identities and separate volumes', () => {
    const s = fixtureStorage();
    s.volumes.data.name = 'devflow';
    expect(() => receipt(s, run)).toThrow();
    const alias = fixtureStorage();
    alias.volumes.evidence = {
      ...alias.volumes.data,
      labels: { 'devflow.rehearsal': run, 'devflow.rehearsal.role': 'evidence' },
    };
    expect(() => receipt(alias, run)).toThrow('VOLUME_ALIAS');
  });
  it('rejects indeterminate absence and collisions', () => {
    expect(() => absent(null, 'x')).toThrow('INDETERMINATE');
    expect(() => absent(['x'], 'x')).toThrow('ALREADY_EXISTS');
  });
  it('does not interpret a Docker listing error as absence or create anything', () => {
    const docker = vi.fn(() => {
      throw Error('inspection unavailable');
    });
    const journal = vi.fn();
    expect(() =>
      prepare(
        run,
        `sha256:${'b'.repeat(64)}`,
        fixturePins(),
        docker,
        journal,
        () => Date.now(),
        'f'.repeat(64),
      ),
    ).toThrow();
    expect(docker).toHaveBeenCalledTimes(1);
    expect(journal).not.toHaveBeenCalled();
  });
  it('blocks unresolved provenance before Docker calls', () => {
    const docker = vi.fn();
    expect(() =>
      prepare(run, `sha256:${'b'.repeat(64)}`, { approved: false }, docker, () => {}),
    ).toThrow('PROVENANCE');
    expect(docker).not.toHaveBeenCalled();
    expect(() => provenance(fixturePins())).not.toThrow();
  });
  function io(files: string[] = []) {
    return {
      existsSync: (p: string) => p === '/.dockerenv',
      realpathSync: () => '/work',
      readFileSync: () =>
        `1 0 0:1 / / ro - overlay overlay ro\n2 0 0:2 /var/lib/docker/volumes/${'d'.repeat(64)}/_data /admission/data rw - ext4 disk rw\n3 0 0:3 /var/lib/docker/volumes/${'e'.repeat(64)}/_data /admission/evidence rw - ext4 disk rw`,
      readdirSync: (p: string) => (p.endsWith('data') ? files : []),
      writeFileSync: vi.fn(),
      chownSync: vi.fn(),
    };
  }
  it('checks BOTH empty roots before writing a marker', () => {
    const fs = io(['PG_VERSION']);
    expect(() => admit(fs, run, fixtureStorage())).toThrow('NOT_EMPTY');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    const other = io();
    other.readdirSync = () => ['old-marker'];
    expect(() => admit(other, run, fixtureStorage())).toThrow();
    expect(other.writeFileSync).not.toHaveBeenCalled();
  });
  it('rejects remote or indeterminate actual backing filesystems without writes', () => {
    const fs = io(),
      original = fs.readFileSync;
    fs.readFileSync = () => original().replaceAll('ext4', 'nfs4');
    expect(() => admit(fs, run, fixtureStorage())).toThrow('VOLUME_FILESYSTEM');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    fs.readFileSync = () => original().replace('/var/lib/docker/volumes/', '/foreign/');
    expect(() => admit(fs, run, fixtureStorage())).toThrow('VOLUME_FILESYSTEM');
  });
  it('admits clean roots with synthetic IO only and retains proof', () => {
    const fs = io();
    expect(() => inspectEmpty(fs, run, fixtureStorage())).not.toThrow();
    admit(fs, run, fixtureStorage());
    expect(fs.writeFileSync).toHaveBeenCalledTimes(3);
    expect(fs.chownSync).toHaveBeenCalledWith('/admission/evidence', 1000, 1000);
  });
});
describe('operation boundaries', () => {
  it('poisons the lane on timeout and cannot report late success', async () => {
    vi.useFakeTimers();
    const statuses: object[] = [];
    const lane = new OperationLane((s: object) => statuses.push(s));
    let release!: (v: string) => void;
    const result = lane
      .run(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        { milliseconds: 10 },
      )
      .catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(11);
    expect(await result).toContain('DEADLINE');
    release('late');
    await Promise.resolve();
    await expect(lane.run(async () => true)).rejects.toThrow('LOCKED');
    expect(statuses).not.toContainEqual({ state: 'COMPLETED' });
  });
  it('client cancellation poisons even an operation that later settles', async () => {
    const lane = new OperationLane();
    const signal = new AbortController();
    let release!: () => void;
    const result = lane
      .run(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        { signal: signal.signal },
      )
      .catch((e: Error) => e.message);
    signal.abort();
    expect(await result).toContain('CANCELLED');
    release();
    await Promise.resolve();
    expect(lane.blocked).toBe(true);
  });
  it('bounds a stuck individual predicate rather than waiting forever', async () => {
    vi.useFakeTimers();
    const result = until(() => new Promise(() => {}), 'STUCK', 10).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(11);
    expect(await result).toContain('DEADLINE');
  });
  it('blocks query continuation after cancellation and preserves transaction rollback signaling', async () => {
    let cancelled = false;
    const check = () => {
      if (cancelled) throw Error('CANCELLED');
    };
    const create = vi.fn(async () => {
      cancelled = true;
      return 'committed before cancellation';
    });
    const raw = {
      task: { create },
      $transaction: vi.fn(async (cb: (tx: object) => Promise<unknown>, options?: unknown) => {
        void options;
        return cb({ task: { create } });
      }),
    };
    const db = guardedDatabase(raw, () => ({ check }));
    await expect(db.$transaction((tx: typeof db) => tx.task.create({}))).rejects.toThrow(
      'CANCELLED',
    );
    expect(raw.$transaction.mock.calls[0][1]).toMatchObject({ maxWait: 3000, timeout: 10000 });
    await expect(async () => db.task.create({})).rejects.toThrow('CANCELLED');
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('does not execute cancelled SQL before import-time work', async () => {
    const query = vi.fn();
    const db = guardedDatabase({ $queryRaw: query }, () => ({
      check: () => {
        throw Error('CANCELLED');
      },
    }));
    expect(() => db.$queryRaw()).toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('cleanup can get a separate budget without reviving the cancelled operation', async () => {
    const op = {
      check: () => {
        throw Error('CANCELLED');
      },
    };
    expect(() => current.run(op, () => current.run(undefined, () => {}))).not.toThrow();
  });
});
describe('owned exits and readiness', () => {
  it.each([
    { code: 1, signal: null },
    { code: null, signal: 'SIGKILL' },
    { code: 0, signal: null },
  ])('does not bless an unvalidated exit %j', async (exit) => {
    const w = new Workers(() => {});
    w.records.set('a', { exit, validatedExit: false });
    await expect(w.stop('a')).rejects.toThrow('UNEXPECTED_EXIT');
  });
  it('accepts only an intentional validated crash for later drain', async () => {
    const w = new Workers(() => {}),
      child = fakeChild();
    const r = {
      child,
      pid: 123,
      token: 'owned',
      exit: null,
      events: [],
      validatedExit: false,
      expected: null,
    };
    w.records.set('a', r);
    w.signal('a', 'SIGKILL');
    Object.assign(r, { exit: { code: null, signal: 'SIGKILL' } });
    await w.exited('a', null, 'SIGKILL');
    await expect(w.stop('a')).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('does not accept an old aggregate heartbeat as replacement readiness', async () => {
    vi.useFakeTimers();
    const w = new Workers(() => {});
    const r = { exit: null, error: false, events: [] as object[] };
    w.records.set('b', r);
    const find = vi.fn(async () => ({
      runId: 'new',
      connectionId: 'connection',
      state: 'RUNNING',
      polledAt: new Date(),
      heartbeatAt: new Date(),
      staleAfterMs: 45000,
      idleAt: new Date(),
    }));
    const db = { gitHubWorkerSignal: { findUnique: find } };
    let ready = false;
    const result = w.ready('b', db, 'connection').then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(201);
    expect(ready).toBe(false);
    expect(find).not.toHaveBeenCalled();
    r.events.push(
      { type: 'health-run', runId: 'new' },
      { type: 'polled', runId: 'old', idle: true },
    );
    await vi.advanceTimersByTimeAsync(201);
    expect(ready).toBe(false);
    r.events.push({ type: 'polled', runId: 'new', idle: true });
    await vi.advanceTimersByTimeAsync(201);
    await result;
    expect(find).toHaveBeenCalledWith({
      where: { runId_connectionId: { runId: 'new', connectionId: 'connection' } },
    });
  });
});
describe('migration lifecycle using fake children', () => {
  function log() {
    return { attach: vi.fn(), onError: vi.fn(), end: vi.fn(async () => {}) };
  }
  it('does not spawn if exclusive log opening fails', async () => {
    const child = vi.fn();
    await expect(
      new Migration().run({
        openLog: async () => {
          throw Error('log collision');
        },
        forkChild: child,
      }),
    ).rejects.toThrow();
    expect(child).not.toHaveBeenCalled();
  });
  it('requires a terminal descendants-drained receipt and actual close', async () => {
    const c = fakeChild(),
      l = log(),
      m = new Migration();
    const result = m.run({ openLog: async () => l, forkChild: () => c });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    c.emit('message', { type: 'migration-terminal', code: 0, descendants: 0 });
    c.emit('exit', 0, null);
    c.emit('close');
    await result;
    expect(l.end).toHaveBeenCalled();
    expect(m.unresolved).toBe(false);
  });
  it('does not mark a zero-exit guardian without descendant proof successful', async () => {
    const c = fakeChild(),
      m = new Migration();
    const result = m.run({ openLog: async () => log(), forkChild: () => c });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    c.emit('exit', 0, null);
    c.emit('close');
    await expect(result).rejects.toThrow('MIGRATION_FAILED');
    expect(m.unresolved).toBe(true);
  });
  it('waits for guardian closure after cancellation before releasing work', async () => {
    const c = fakeChild(),
      m = new Migration(),
      abort = new AbortController();
    let settled = false;
    const result = m
      .run({ openLog: async () => log(), forkChild: () => c, signal: abort.signal })
      .catch(() => {
        settled = true;
      });
    for (let i = 0; i < 12; i++) await Promise.resolve();
    abort.abort();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(c.send).toHaveBeenCalledWith({ type: 'cancel' }, expect.any(Function));
    expect(settled).toBe(false);
    c.emit('message', { type: 'migration-terminal', code: 1, descendants: 0 });
    c.emit('exit', 1, null);
    c.emit('close');
    await result;
  });
  it('owns descendants by object and detects unknown or orphaned namespace processes', () => {
    const d = new Descendants([
      { pid: 1, ppid: 0, start: 'one' },
      { pid: 100, ppid: 1, start: 'guardian' },
    ]);
    const c = fakeChild();
    d.add(c, 'engine');
    expect(
      d.inspect(
        [
          { pid: 1, ppid: 0, start: 'one' },
          { pid: 100, ppid: 1, start: 'guardian' },
          { pid: 123, ppid: 100, start: 'engine' },
        ],
        100,
      ),
    ).toBe(false);
    expect(() => d.inspect([{ pid: 124, ppid: 1, start: 'orphan' }], 100)).toThrow(
      'UNTRACKED_NAMESPACE_PROCESS',
    );
    d.terminate();
    expect(c.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
describe('false-success assertion regressions', () => {
  const old = { leaseToken: 'a', attempts: 1 },
    active = { state: 'PROCESSING', leaseToken: 'b', attempts: 2, leaseExpiresAt: new Date(2000) };
  it('requires an active replacement lease with different ownership', () => {
    expect(() => assertions.replacement(old, active, new Date(1000))).not.toThrow();
    expect(() =>
      assertions.replacement(old, { ...active, state: 'PROCESSED' }, new Date(1000)),
    ).toThrow();
    expect(() =>
      assertions.replacement(old, { ...active, leaseToken: 'a' }, new Date(1000)),
    ).toThrow();
  });
  it('rejects a stale-owner result that damages a still-active replacement', () => {
    const result = { committed: false, renewed: false, failed: false };
    expect(() => assertions.fenced(result, active, active, new Date(1000))).not.toThrow();
    expect(() =>
      assertions.fenced(result, active, { ...active, leaseToken: 'a' }, new Date(1000)),
    ).toThrow();
    expect(() =>
      assertions.fenced({ ...result, committed: true }, active, active, new Date(1000)),
    ).toThrow();
  });
  it.each([0, -1, 999, 2001])('rejects invalid retry delay %s', (delay) =>
    expect(() => assertions.retryWindow(new Date(0), new Date(0), 1, new Date(delay))).toThrow(
      'BACKOFF',
    ),
  );
  it('requires bounded timing evidence and positive jittered backoff', () => {
    expect(() =>
      assertions.retryWindow(new Date(0), new Date(100), 1, new Date(1500)),
    ).not.toThrow();
    expect(() => assertions.retryWindow(new Date(0), new Date(600), 1, new Date(1500))).toThrow();
  });
  it.each([
    'objects',
    'observations',
    'links',
    'evidence',
    'activities',
    'executions',
    'applied',
    'skipped',
  ])('rejects extra %s effects', (key) => {
    const c = {
      objects: 1,
      observations: 2,
      links: 1,
      evidence: 2,
      activities: 1,
      executions: 2,
      applied: 1,
      skipped: 1,
    };
    expect(() => assertions.publication(c, true)).not.toThrow();
    expect(() =>
      assertions.publication({ ...c, [key]: c[key as keyof typeof c] + 1 }, true),
    ).toThrow();
  });
});

describe('complete storage admission protocol with a fake Docker transport', () => {
  function fakeDocker(shared = false) {
    const s = fixtureStorage();
    let created = 0;
    return vi.fn((args: string[], input?: string) => {
      const [command, action] = args;
      if (command === 'volume' && action === 'ls') return '';
      if (command === 'container' && action === 'ls')
        return shared ? JSON.stringify('9'.repeat(64)) : '';
      if (command === 'network' && action === 'ls') return '';
      if (command === 'volume' && action === 'create')
        return s.volumes[created++ === 0 ? 'data' : 'evidence'].name;
      if (command === 'volume' && action === 'inspect')
        return JSON.stringify(
          Object.values(s.volumes).find((v: unknown) => (v as { name: string }).name === args[2]),
        );
      if (command === 'image') return JSON.stringify(s.postgresImageId);
      if (command === 'create') return s.probe.id;
      if (command === 'start') {
        expect(input).toBeTruthy();
        return 'REHEARSAL_STORAGE_EMPTY_VERIFIED';
      }
      if (command === 'container' && action === 'inspect' && args[4]?.includes('readonly'))
        return JSON.stringify({
          imageId: s.probe.imageId,
          readonly: true,
          privileged: false,
          pidMode: '',
          ipcMode: 'private',
          network: 'none',
          user: '0',
          entrypoint: ['/bin/sh', '/work/rehearsal/entrypoint.sh'],
          command: ['storage-probe', run],
          mounts: ['data', 'evidence'].map((role) => ({
            Type: 'volume',
            Name: s.volumes[role].name,
            Destination: `/admission/${role}`,
          })),
        });
      if (command === 'container' && action === 'inspect' && shared)
        return JSON.stringify({
          name: '/foreign',
          id: '9'.repeat(64),
          mounts: [{ Name: s.volumes.data.name }],
        });
      if (command === 'container' && action === 'inspect')
        return JSON.stringify({ running: false, exitCode: 0 });
      throw Error('unexpected fake Docker command');
    });
  }
  it('allocates anonymous volumes and verifies the probe without ever starting PostgreSQL', () => {
    const s = fixtureStorage(),
      docker = fakeDocker();
    let clock = 0;
    const journal = vi.fn();
    const result = prepare(
      run,
      s.probe.imageId,
      fixturePins(),
      docker,
      journal,
      () => Date.parse(clock++ === 0 ? s.startedAt : s.admittedAt),
      s.nonce,
    );
    expect(result.volumes.data.name).toBe(s.volumes.data.name);
    const creates = docker.mock.calls.filter(
      ([args]) => args[0] === 'volume' && args[1] === 'create',
    );
    expect(creates).toHaveLength(2);
    expect(creates.every(([args]) => !args.includes(s.volumes.data.name))).toBe(true);
    const startIndex = docker.mock.calls.findIndex(([args]) => args[0] === 'start');
    const configIndex = docker.mock.calls.findIndex(
      ([args]) => args[0] === 'container' && args[1] === 'inspect' && args[4]?.includes('readonly'),
    );
    expect(configIndex).toBeLessThan(startIndex);
    expect(docker.mock.calls.some(([args]) => args[0] === 'run')).toBe(false);
    expect(journal).toHaveBeenLastCalledWith({ state: 'STORAGE_ADMITTED', runId: run });
  });
  it('rejects backing storage already referenced by another container before PG startup', () => {
    expect(() => beforePostgres(run, fixtureStorage(), fakeDocker(true))).toThrow('VOLUME_REUSED');
  });
  it('rejects volume metadata inspection failure rather than assuming freshness', () => {
    const docker = vi.fn(() => {
      throw Error('unavailable');
    });
    expect(() => beforePostgres(run, fixtureStorage(), docker)).toThrow();
    expect(docker).toHaveBeenCalledTimes(1);
  });
});

describe('unresolved work and durable evidence regressions', () => {
  it('cannot launch work when evidence storage fails', async () => {
    const lane = new OperationLane(() => {
      throw Error('disk unavailable');
    });
    const work = vi.fn();
    await expect(lane.run(work)).rejects.toThrow('EVIDENCE_UNRESOLVED');
    expect(work).not.toHaveBeenCalled();
    expect(lane.blocked).toBe(true);
  });
  it('retains unresolved migration ownership when the guardian never confirms closure', async () => {
    vi.useFakeTimers();
    const c = fakeChild(),
      m = new Migration();
    const result = m
      .run({
        openLog: async () => ({ attach: () => {}, onError: () => {}, end: async () => {} }),
        forkChild: () => c,
      })
      .catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(165001);
    expect(await result).toContain('DEADLINE');
    expect(m.unresolved).toBe(true);
    expect(m.record.child).toBe(c);
    expect(c.send).toHaveBeenCalledWith({ type: 'cancel' }, expect.any(Function));
  });
  it('rejects PID reuse in the private namespace without signaling that process', () => {
    const d = new Descendants([{ pid: 1, ppid: 0, start: 'first' }]);
    expect(() => d.inspect([{ pid: 1, ppid: 0, start: 'reused' }], 123)).toThrow(
      'UNTRACKED_NAMESPACE',
    );
  });
  it('records a successful owned graceful shutdown before accepting drain', async () => {
    const w = new Workers(() => {}),
      child = fakeChild();
    const r = {
      child,
      pid: 123,
      token: 'owned',
      exit: null,
      events: [],
      validatedExit: false,
      expected: null,
    };
    w.records.set('a', r);
    w.signal('a', 'SIGTERM');
    Object.assign(r, { exit: { code: 0, signal: null } });
    await w.exited('a');
    await expect(w.stop('a')).resolves.toBeUndefined();
    expect(r.validatedExit).toBe(true);
  });
});
it('rejects arbitrary admission paths and path traversal', () => {
  const { admissionPath } = require('./storage-policy.cjs');
  expect(admissionPath('/tmp/devflow-worker-rehearsal.1234abcd/admission.json')).toContain('/tmp/');
  for (const file of [
    '/tmp/../home/user/admission.json',
    '/tmp/anything/admission.json',
    '/home/user/.env',
  ])
    expect(() => admissionPath(file)).toThrow('ADMISSION_PATH');
});
it('does not spawn if the opened migration log already reports an IO failure', async () => {
  const child = vi.fn();
  const m = new Migration();
  await expect(
    m.run({
      openLog: async () => ({ onError: (fn: () => void) => fn(), end: async () => {} }),
      forkChild: child,
    }),
  ).rejects.toThrow('PRIVATE_LOG_FAILED');
  expect(child).not.toHaveBeenCalled();
});
it('retains and drains a migration child when attaching its log fails', async () => {
  const c = fakeChild(),
    m = new Migration();
  let done = false;
  const result = m
    .run({
      openLog: async () => ({
        onError: () => {},
        attach: () => {
          throw Error('attach failed');
        },
        end: async () => {},
      }),
      forkChild: () => c,
    })
    .catch((e: Error) => {
      done = true;
      return e.message;
    });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(c.send).toHaveBeenCalledWith({ type: 'cancel' }, expect.any(Function));
  expect(done).toBe(false);
  c.emit('message', { type: 'migration-terminal', code: 1, descendants: 0 });
  c.emit('exit', 1, null);
  c.emit('close');
  expect(await result).toBe('attach failed');
});
