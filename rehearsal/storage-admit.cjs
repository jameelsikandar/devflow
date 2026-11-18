/* eslint-disable @typescript-eslint/no-require-imports -- Explicitly approved host admission only. */
'use strict';
// Import is inert. The CLI creates NEW resources only; it never removes anything.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { names, insist } = require('./policy.cjs');
const { absent, volume, receipt, provenance } = require('./storage-policy.cjs');
function prepare(
  runId,
  imageId,
  pins,
  docker,
  journal,
  clock = Date.now,
  nonce = randomBytes(32).toString('hex'),
) {
  const n = names(runId);
  provenance(pins);
  insist(/^sha256:[a-f0-9]{64}$/.test(imageId), 'IMAGE_ID');
  const lines = (raw) =>
    raw.trim()
      ? raw
          .trim()
          .split('\n')
          .map((v) => JSON.parse(v))
      : [];
  // Failed listings throw. There is no error-to-absence conversion.
  const containers = lines(docker(['container', 'ls', '-a', '--format', '{{json .Names}}']));
  for (const name of [n.postgres, n.controller, n.admission]) absent(containers, name);
  absent(lines(docker(['network', 'ls', '--format', '{{json .Name}}'])), n.network);
  const prior = lines(docker(['volume', 'ls', '--format', '{{json .Name}}']));
  const started = clock(),
    volumes = {};
  journal({ state: 'ADMISSION_STARTED', runId });
  for (const role of ['data', 'evidence']) {
    // No supplied name: Docker allocates a fresh anonymous 256-bit identity.
    const name = docker([
      'volume',
      'create',
      '--driver',
      'local',
      '--label',
      `devflow.rehearsal=${runId}`,
      '--label',
      `devflow.rehearsal.role=${role}`,
    ]).trim();
    insist(/^[a-f0-9]{64}$/.test(name), 'ANONYMOUS_VOLUME_REQUIRED');
    absent(prior, name);
    journal({ state: 'VOLUME_CREATED', role, name });
    const meta = JSON.parse(
      docker([
        'volume',
        'inspect',
        name,
        '--format',
        '{"name":{{json .Name}},"driver":{{json .Driver}},"optionCount":{{len .Options}},"scope":{{json .Scope}},"createdAt":{{json .CreatedAt}},"labels":{{json .Labels}}}',
      ]),
    );
    meta.id = meta.name;
    // Docker may serialize CreatedAt only to seconds; start is rounded down solely for this timestamp precision.
    volume(meta, runId, role, Math.floor(started / 1000) * 1000, clock());
    volumes[role] = meta;
  }
  insist(volumes.data.name !== volumes.evidence.name, 'VOLUME_ALIAS');
  const postgresImageId = JSON.parse(
    docker(['image', 'inspect', pins.postgresImage, '--format', '{{json .Id}}']),
  );
  insist(/^sha256:[a-f0-9]{64}$/.test(postgresImageId), 'POSTGRES_IMAGE');
  const id = docker([
    'create',
    '--pull=never',
    '-i',
    '--name',
    n.admission,
    '--label',
    `devflow.rehearsal=${runId}`,
    '--network',
    'none',
    '--ipc',
    'private',
    '--read-only',
    '--user',
    '0',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'CHOWN',
    '--security-opt',
    'no-new-privileges',
    '--mount',
    `type=volume,source=${volumes.data.name},target=/admission/data`,
    '--mount',
    `type=volume,source=${volumes.evidence.name},target=/admission/evidence`,
    imageId,
    'storage-probe',
    runId,
  ]).trim();
  insist(/^[a-f0-9]{64}$/.test(id), 'PROBE_ID');
  journal({ state: 'PROBE_CREATED', id, name: n.admission });
  const proof = JSON.parse(
    docker([
      'container',
      'inspect',
      id,
      '--format',
      '{"imageId":{{json .Image}},"readonly":{{json .HostConfig.ReadonlyRootfs}},"privileged":{{json .HostConfig.Privileged}},"pidMode":{{json .HostConfig.PidMode}},"ipcMode":{{json .HostConfig.IpcMode}},"network":{{json .HostConfig.NetworkMode}},"user":{{json .Config.User}},"mounts":{{json .Mounts}},"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}}}',
    ]),
  );
  insist(
    proof.imageId === imageId &&
      proof.readonly === true &&
      !proof.privileged &&
      proof.pidMode === '' &&
      proof.ipcMode === 'private' &&
      proof.network === 'none' &&
      proof.user === '0',
    'PROBE_CONFIGURATION',
  );
  insist(
    JSON.stringify(proof.entrypoint) ===
      JSON.stringify(['/bin/sh', '/work/rehearsal/entrypoint.sh']) &&
      JSON.stringify(proof.command) === JSON.stringify(['storage-probe', runId]),
    'PROBE_ENTRYPOINT',
  );
  insist(
    proof.mounts?.length === 2 &&
      ['data', 'evidence'].every((role) =>
        proof.mounts.some(
          (m) =>
            m.Type === 'volume' &&
            m.Name === volumes[role].name &&
            m.Destination === `/admission/${role}`,
        ),
      ),
    'PROBE_MOUNTS',
  );
  const value = {
    version: 2,
    runId,
    nonce,
    startedAt: new Date(Math.floor(started / 1000) * 1000).toISOString(),
    admittedAt: new Date(clock()).toISOString(),
    volumes,
    probe: { id, name: n.admission, imageId, emptyVerified: true },
    postgresImageId,
  };
  receipt(value, runId);
  // Only this newly created, identified helper is started. No PostgreSQL is started here.
  const output = docker(['start', '--attach', '--interactive', id], JSON.stringify(value));
  const terminal = JSON.parse(
    docker([
      'container',
      'inspect',
      id,
      '--format',
      '{"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}}}',
    ]),
  );
  insist(
    !terminal.running &&
      terminal.exitCode === 0 &&
      output.trim() === 'REHEARSAL_STORAGE_EMPTY_VERIFIED',
    'PROBE_FAILED',
  );
  journal({ state: 'STORAGE_ADMITTED', runId });
  return value;
}
function beforePostgres(runId, value, docker) {
  receipt(value, runId);
  const n = names(runId);
  for (const role of ['data', 'evidence']) {
    const meta = JSON.parse(
      docker([
        'volume',
        'inspect',
        value.volumes[role].name,
        '--format',
        '{"name":{{json .Name}},"driver":{{json .Driver}},"optionCount":{{len .Options}},"scope":{{json .Scope}},"createdAt":{{json .CreatedAt}},"labels":{{json .Labels}}}',
      ]),
    );
    meta.id = meta.name;
    volume(meta, runId, role, Date.parse(value.startedAt), Date.parse(value.admittedAt));
    insist(meta.createdAt === value.volumes[role].createdAt, 'VOLUME_REPLACED');
  }
  const ids = docker(['container', 'ls', '-a', '--no-trunc', '--format', '{{json .ID}}'])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((v) => JSON.parse(v));
  let probe = false;
  for (const id of ids) {
    insist(/^[a-f0-9]{64}$/.test(id), 'RESOURCE_LIST_INDETERMINATE');
    const c = JSON.parse(
      docker([
        'container',
        'inspect',
        id,
        '--format',
        '{"name":{{json .Name}},"id":{{json .Id}},"mounts":{{json .Mounts}},"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}},"imageId":{{json .Image}}}',
      ]),
    );
    insist(
      ![n.postgres, n.controller].includes(c.name.replace(/^\//, '')),
      'RESOURCE_ALREADY_EXISTS',
    );
    const shared = c.mounts.some((m) =>
      [value.volumes.data.name, value.volumes.evidence.name].includes(m.Name),
    );
    if (shared) insist(c.id === value.probe.id, 'VOLUME_REUSED');
    if (c.id === value.probe.id) {
      insist(
        c.name === `/${n.admission}` &&
          c.running === false &&
          c.exitCode === 0 &&
          c.imageId === value.probe.imageId,
        'PROBE_FAILED',
      );
      probe = true;
    }
  }
  insist(probe, 'PROBE_MISSING');
  return true;
}
if (require.main === module) {
  let fd, output;
  try {
    const [runId, approve, scope, imageId, path] = process.argv.slice(2);
    insist(
      process.argv.length === 7 &&
        approve === '--approve' &&
        scope === 'storage' &&
        path?.startsWith('/tmp/'),
      'APPROVAL',
    );
    require('./storage-policy.cjs').admissionPath(path);
    const pins = provenance(
      JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'provenance.json'), 'utf8')),
    );
    output = fs.openSync(path, 'wx', 0o600);
    fd = fs.openSync(`${path}.journal`, 'wx', 0o600); // Before any Docker resource creation.
    const configPath = require('node:path').join(
      require('node:path').dirname(path),
      'docker-empty',
    );
    const docker = (args, input) => {
      insist(fs.readdirSync(configPath).length === 0, 'DOCKER_CONFIG_NOT_EMPTY');
      return execFileSync(
        '/usr/bin/docker',
        [
          '--host',
          'unix:///var/run/docker.sock',
          '--config',
          require('node:path').join(require('node:path').dirname(path), 'docker-empty'),
          ...args,
        ],
        {
          input,
          env: { PATH: '/usr/bin:/bin', HOME: require('node:path').dirname(path) },
          encoding: 'utf8',
          timeout: 90000,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    };
    const value = prepare(runId, imageId, pins, docker, (event) =>
      fs.writeSync(fd, JSON.stringify(event) + '\n'),
    );
    fs.writeSync(output, JSON.stringify(value));
    fs.fsyncSync(output);
    console.log('REHEARSAL_STORAGE_ADMITTED');
  } catch {
    console.error('REHEARSAL_STORAGE_UNRESOLVED_RETAIN_RESOURCES');
    process.exitCode = 1;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (output !== undefined) fs.closeSync(output);
  }
}
module.exports = { prepare, beforePostgres };
