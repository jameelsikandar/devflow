/* eslint-disable @typescript-eslint/no-require-imports -- Pure storage-policy validation is loaded lazily. */
'use strict';
// Pure policy only: no application imports, connections, subprocesses or writes.
const RUN = /^\d{8}T\d{6}Z_[a-f0-9]{8}$/;
const PG_COMMAND = [
  'postgres',
  '-c',
  'statement_timeout=8000',
  '-c',
  'lock_timeout=3000',
  '-c',
  'idle_in_transaction_session_timeout=12000',
  '-c',
  'authentication_timeout=5s',
];
const FIXTURE_KEY = 'ab'.repeat(32);
const SCENARIOS = Object.freeze({
  'idle-active': 'workers',
  'graceful-shutdown': 'signals',
  'crash-recovery': 'faults',
  'stale-owner-fencing': 'faults',
  'retry-backoff': 'faults',
  'dead-letter': 'faults',
  'automation-idempotency': 'automation',
  'duplicate-events': 'workers',
  'supervisor-restart': 'faults',
});
function insist(condition, code) {
  if (!condition) throw new Error(`REHEARSAL_${code}`);
}
function names(runId) {
  insist(typeof runId === 'string' && RUN.test(runId), 'INVALID_RUN_ID');
  return Object.freeze({
    runId,
    database: `devflow_worker_rehearsal_${runId}_test`,
    network: `devflow-worker-net-${runId}`,
    postgres: `devflow-worker-pg-${runId}`,
    controller: `devflow-worker-control-${runId}`,
    admission: `devflow-worker-admit-${runId}`,
  });
}
function databaseUrl(runId) {
  return `postgresql://worker_fixture_admin:fixture_only@worker-pg:5432/${names(runId).database}?schema=public&connect_timeout=5&pool_timeout=5&socket_timeout=10&connection_limit=3`;
}
function environment(env) {
  const expected = names(env.REHEARSAL_RUN_ID);
  insist(env.REHEARSAL_DATABASE === expected.database, 'DATABASE_NAME');
  // Exact string prevents query-host overrides, aliasing or arbitrary credentials.
  insist(env.DATABASE_URL === databaseUrl(expected.runId), 'DATABASE_URL');
  insist(env.NODE_ENV === 'test', 'NODE_ENV');
  insist(
    env.CHECKPOINT_DISABLE === '1' && env.PRISMA_HIDE_UPDATE_MESSAGE === '1',
    'TELEMETRY_CONFIG',
  );
  insist(env.TOKEN_ENCRYPTION_KEY === FIXTURE_KEY, 'SYNTHETIC_KEY_REQUIRED');
  insist(env.APP_URL === 'http://127.0.0.1:1' && env.GITHUB_DEMO === 'false', 'APP_CONFIG');
  for (const key of ['AI_API_KEY', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'])
    insist(env[key] === '', 'LIVE_CREDENTIAL');
  for (const key of Object.keys(env))
    if (
      (/^(PG|DOTENV_|PRISMA_)/.test(key) && key !== 'PRISMA_HIDE_UPDATE_MESSAGE') ||
      ['NODE_OPTIONS', 'TEST_DATABASE_URL'].includes(key)
    )
      insist(!env[key], 'INHERITED_OVERRIDE');
  const allowed = new Set([
    'CHECKPOINT_DISABLE',
    'PRISMA_HIDE_UPDATE_MESSAGE',
    'PATH',
    'HOSTNAME',
    'HOME',
    'NODE_VERSION',
    'YARN_VERSION',
    'TERM',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'PWD',
    'SHLVL',
    '_',
    'NODE_ENV',
    'REHEARSAL_RUN_ID',
    'REHEARSAL_DATABASE',
    'DATABASE_URL',
    'TOKEN_ENCRYPTION_KEY',
    'APP_URL',
    'GITHUB_DEMO',
    'AI_API_KEY',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'REHEARSAL_CONNECTION_ID',
    'REHEARSAL_GATE',
    'GITHUB_WORKER_CONNECTION_ID',
    'GITHUB_WORKER_CONCURRENCY',
    'GITHUB_WORKER_LEASE_SECONDS',
    'GITHUB_WORKER_MAX_ATTEMPTS',
    'GITHUB_WORKER_POLL_MS',
    'GITHUB_WORKER_ONCE_LIMIT',
  ]);
  for (const key of Object.keys(env)) insist(allowed.has(key), 'UNEXPECTED_ENVIRONMENT');
  return expected;
}
function requireStorage(value, runId) {
  return require('./storage-policy.cjs').receipt(value, runId);
}
function inventory(value, runId, cleanup = false) {
  const expected = names(runId);
  requireStorage(value?.storage, runId);
  const dataName = value.storage.volumes.data.name,
    evidenceName = value.storage.volumes.evidence.name;
  insist(value.storage.probe.imageId === value.resources?.controller?.imageId, 'PROBE_IMAGE');
  insist(value.resources?.postgres?.imageId === value.storage.postgresImageId, 'POSTGRES_IMAGE');
  insist(value.resources?.admission?.id === value.storage.probe.id, 'PROBE_ID');
  insist(value?.version === 1 && value.runId === runId, 'RESOURCE_INVENTORY');
  const spec = [
    ['network', expected.network],
    ['postgres', expected.postgres],
    ['controller', expected.controller],
    ['data', dataName],
    ['evidence', evidenceName],
    ['admission', expected.admission],
  ];
  insist(
    Object.keys(value.resources || {})
      .sort()
      .join() ===
      spec
        .map(([k]) => k)
        .sort()
        .join(),
    'RESOURCE_SET',
  );
  for (const [kind, name] of spec) {
    const resource = value.resources[kind];
    insist(
      resource.name === name && resource.labels?.['devflow.rehearsal'] === runId,
      'RESOURCE_OWNER',
    );
    insist(
      typeof resource.id === 'string' && /^[a-zA-Z0-9_-]{12,128}$/.test(resource.id),
      'RESOURCE_ID',
    );
  }
  for (const role of ['data', 'evidence']) {
    const v = value.resources[role],
      admitted = value.storage.volumes[role];
    insist(
      v.driver === 'local' &&
        v.optionCount === 0 &&
        v.scope === 'local' &&
        v.createdAt === admitted.createdAt &&
        v.name === admitted.name,
      'VOLUME_CHANGED',
    );
  }
  const probe = value.resources.admission;
  insist(
    probe.running === false &&
      probe.exitCode === 0 &&
      probe.networkMode === 'none' &&
      probe.readOnlyRootfs === true &&
      probe.publishedPorts === 0 &&
      probe.privileged === false,
    'PROBE_STATE',
  );
  insist(
    probe.mounts?.length === 2 &&
      probe.mounts.every(
        (m) =>
          m.type === 'volume' &&
          ((m.source === dataName && m.target === '/admission/data') ||
            (m.source === evidenceName && m.target === '/admission/evidence')),
      ),
    'PROBE_MOUNTS',
  );
  insist(value.resources.network.internal === true, 'NETWORK_EGRESS');
  const peers = value.resources.network.peers;
  const ownedPeers = [expected.postgres, expected.controller];
  insist(
    Array.isArray(peers) &&
      new Set(peers).size === peers.length &&
      peers.every((p) => ownedPeers.includes(p)) &&
      (cleanup || peers.length === 2),
    'NETWORK_PEERS',
  );
  insist(value.resources.postgres.databaseAlias === true, 'DATABASE_ALIAS');
  for (const kind of ['postgres', 'controller']) {
    const c = value.resources[kind];
    insist(
      Array.isArray(c.networks) && c.networks.length === 1 && c.networks[0] === expected.network,
      'NETWORK_ATTACHMENTS',
    );
    insist(c.publishedPorts === 0 && c.privileged === false, 'CONTAINER_EXPOSURE');
    insist(Array.isArray(c.mounts), 'MOUNTS');
    const allowed =
      kind === 'postgres'
        ? [[dataName, '/var/lib/postgresql', true]]
        : [[evidenceName, '/evidence', true]];
    insist(c.mounts.length === allowed.length, 'MOUNT_COUNT');
    for (const [source, target, writable] of allowed)
      insist(
        c.mounts.some(
          (m) =>
            m.type === 'volume' &&
            m.source === source &&
            m.target === target &&
            m.writable === writable,
        ),
        'HOST_MOUNT',
      );
    if (cleanup) insist(c.running === false, 'CLEANUP_RUNNING_PROCESS');
  }
  insist(
    value.resources.controller.readOnlyRootfs === true &&
      value.resources.controller.user === 'node',
    'CONTAINER_USER',
  );
  insist(
    typeof value.resources.controller.imageId === 'string' &&
      /^sha256:[a-f0-9]{64}$/.test(value.resources.controller.imageId),
    'IMAGE_ID',
  );
  for (const kind of ['postgres', 'controller', 'admission']) {
    const c = value.resources[kind];
    insist(c.pidMode === '' && c.ipcMode === 'private', 'HOST_NAMESPACE');
    const added = c.capAdd ?? [];
    insist(
      Array.isArray(added) &&
        (kind === 'admission'
          ? added.length === 1 && ['CHOWN', 'CAP_CHOWN'].includes(added[0])
          : added.length === 0),
      'CAPABILITIES',
    );
    if (kind !== 'postgres')
      insist(
        Array.isArray(c.capDrop) && c.capDrop.length === 1 && c.capDrop[0] === 'ALL',
        'CAPABILITIES',
      );
  }
  insist(
    JSON.stringify(value.resources.postgres.command) === JSON.stringify(PG_COMMAND),
    'POSTGRES_TIMEOUT_CONFIG',
  );
  return expected;
}
function command(argv) {
  const [operation, ...args] = argv;
  if (['serve', 'verify-isolation', 'report'].includes(operation)) {
    insist(args.length === 0, 'ARGUMENTS');
    return { operation };
  }
  if (
    ['migrate-disposable', 'create-fixtures', 'configure-inventory', 'abort-owned'].includes(
      operation,
    )
  ) {
    const scope =
      operation === 'migrate-disposable'
        ? 'bootstrap'
        : operation === 'configure-inventory'
          ? 'inventory'
          : operation === 'abort-owned'
            ? 'faults'
            : 'fixtures';
    insist(args.length === 2 && args[0] === '--approve' && args[1] === scope, 'APPROVAL');
    return { operation };
  }
  insist(operation === 'run' && Object.hasOwn(SCENARIOS, args[0]), 'COMMAND');
  insist(
    args.length === 4 &&
      args[1] === '--approve' &&
      args[2] === SCENARIOS[args[0]] &&
      args[3] === '--retain',
    'APPROVAL',
  );
  return { operation, scenario: args[0] };
}
function evidenceLine(event, values = {}) {
  // Never spread arbitrary worker messages, records, URLs or error strings.
  insist(/^[A-Z_]{1,64}$/.test(event), 'EVIDENCE_EVENT');
  const out = { component: 'worker-rehearsal', event };
  for (const key of ['scenario', 'slot', 'state', 'signal', 'code'])
    if (values[key] !== undefined) {
      insist(
        typeof values[key] === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(values[key]),
        'EVIDENCE_VALUE',
      );
      out[key] = values[key];
    }
  for (const key of ['pid', 'exitCode', 'attempts', 'version', 'count', 'restart', 'elapsedMs'])
    if (values[key] !== undefined) {
      insist(values[key] === null || Number.isSafeInteger(values[key]), 'EVIDENCE_NUMBER');
      out[key] = values[key];
    }
  for (const key of ['ok', 'committed', 'renewed', 'failed', 'changed'])
    if (values[key] !== undefined) {
      insist(typeof values[key] === 'boolean', 'EVIDENCE_BOOLEAN');
      out[key] = values[key];
    }
  for (const key of ['heartbeatAt', 'polledAt', 'availableAt', 'leaseExpiresAt'])
    if (values[key] !== undefined) {
      insist(
        values[key] === null ||
          (typeof values[key] === 'string' && !Number.isNaN(Date.parse(values[key]))),
        'EVIDENCE_DATE',
      );
      out[key] = values[key];
    }
  return JSON.stringify(out);
}
function ownedChild(record, child, token, signal) {
  insist(
    record &&
      record.child === child &&
      record.token === token &&
      !record.exit &&
      child.pid === record.pid &&
      Number.isInteger(child.pid) &&
      child.pid > 1,
    'PROCESS_OWNER',
  );
  insist(['SIGTERM', 'SIGKILL', 'SIGSTOP', 'SIGCONT'].includes(signal), 'SIGNAL');
}
function shouldRestart(exit, restarts, limit = 2) {
  return restarts < limit && (exit.signal !== null || exit.code !== 0);
}
function canonicalInventory(value) {
  const result = {
    version: 1,
    runId: value.runId,
    storage: require('./storage-policy.cjs').canonical(value.storage),
    resources: {},
  };
  for (const key of ['network', 'postgres', 'controller', 'data', 'evidence', 'admission']) {
    const r = value.resources[key];
    result.resources[key] = {
      name: r.name,
      id: r.id,
      labels: { 'devflow.rehearsal': value.runId },
    };
    for (const field of [
      'pidMode',
      'ipcMode',
      'capAdd',
      'capDrop',
      'command',
      'driver',
      'optionCount',
      'scope',
      'createdAt',
      'exitCode',
      'networkMode',
      'internal',
      'peers',
      'databaseAlias',
      'networks',
      'publishedPorts',
      'privileged',
      'running',
      'mounts',
      'readOnlyRootfs',
      'user',
      'imageId',
    ])
      if (r[field] !== undefined)
        result.resources[key][field] =
          field === 'mounts'
            ? r[field].map((m) => ({
                type: m.type,
                source: m.source,
                target: m.target,
                writable: m.writable,
              }))
            : r[field];
  }
  return result;
}
module.exports = {
  canonicalInventory,
  names,
  databaseUrl,
  environment,
  inventory,
  command,
  evidenceLine,
  ownedChild,
  shouldRestart,
  insist,
  FIXTURE_KEY,
  SCENARIOS,
  PG_COMMAND,
};
