/* eslint-disable @typescript-eslint/no-require-imports -- Isolated CommonJS worker/preload tooling. */
'use strict';
// Explicitly invoked HOST read-only collector. Never starts/stops/removes resources.
const { execFileSync } = require('node:child_process');
const { names, inventory, canonicalInventory, insist } = require('./policy.cjs');
function collect(runId, inspect, stopped = false, storage) {
  require('./storage-policy.cjs').receipt(storage, runId);
  const n = names(runId),
    resources = {};
  for (const [kind, name] of [
    ['network', n.network],
    ['data', storage.volumes.data.name],
    ['evidence', storage.volumes.evidence.name],
    ['admission', n.admission],
    ['postgres', n.postgres],
    ['controller', n.controller],
  ]) {
    const type =
      kind === 'network' ? 'network' : ['data', 'evidence'].includes(kind) ? 'volume' : 'container';
    // Request labels first; never request Docker Config.Env or full container JSON.
    const labels = inspect(
      type,
      name,
      type === 'container' ? '{{json .Config.Labels}}' : '{{json .Labels}}',
    );
    insist(labels?.['devflow.rehearsal'] === runId, 'RESOURCE_OWNER');
    if (type === 'network') {
      const network = inspect(
        type,
        name,
        '{"id":{{json .Id}},"internal":{{json .Internal}},"containers":{{json .Containers}}}',
      );
      resources[kind] = {
        name,
        labels,
        id: network.id,
        internal: network.internal,
        peers: Object.values(network.containers || {}).map((c) => c.Name),
      };
    } else if (type === 'volume')
      resources[kind] = {
        name,
        labels,
        id: name,
        ...inspect(
          type,
          name,
          '{"driver":{{json .Driver}},"optionCount":{{len .Options}},"scope":{{json .Scope}},"createdAt":{{json .CreatedAt}}}',
        ),
      };
    else {
      const c = inspect(
        type,
        name,
        '{"id":{{json .Id}},"networkMode":{{json .HostConfig.NetworkMode}},"pidMode":{{json .HostConfig.PidMode}},"ipcMode":{{json .HostConfig.IpcMode}},"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"command":{{json .Config.Cmd}},"exitCode":{{json .State.ExitCode}},"networks":{{json .NetworkSettings.Networks}},"ports":{{json .HostConfig.PortBindings}},"privileged":{{json .HostConfig.Privileged}},"running":{{json .State.Running}},"mounts":{{json .Mounts}},"readOnlyRootfs":{{json .HostConfig.ReadonlyRootfs}},"user":{{json .Config.User}},"imageId":{{json .Image}}}',
      );
      resources[kind] = {
        name,
        labels,
        id: c.id,
        networkMode: c.networkMode,
        pidMode: c.pidMode,
        ipcMode: c.ipcMode,
        capAdd: c.capAdd,
        capDrop: c.capDrop,
        command: c.command,
        exitCode: c.exitCode,
        networks: Object.keys(c.networks),
        ...(kind === 'postgres'
          ? { databaseAlias: (c.networks[n.network]?.Aliases || []).includes('worker-pg') }
          : {}),
        publishedPorts: Object.keys(c.ports || {}).length,
        privileged: c.privileged,
        running: c.running,
        readOnlyRootfs: c.readOnlyRootfs,
        user: c.user,
        imageId: c.imageId,
        mounts: c.mounts
          .filter((m) => !(m.Destination === '/tmp' && m.Type === 'tmpfs'))
          .map((m) => ({
            type: m.Type,
            source: m.Name || 'REJECTED_BIND',
            target: m.Destination,
            writable: m.RW,
          })),
      };
    }
  }
  const result = { version: 1, runId, storage, resources };
  inventory(result, runId, stopped);
  return canonicalInventory(result);
}
if (require.main === module) {
  try {
    insist(
      process.argv.length === 4 || (process.argv.length === 5 && process.argv[4] === '--stopped'),
      'ARGUMENTS',
    );
    const inspect = (type, name, format) => {
      insist(
        require('node:fs').readdirSync(
          require('node:path').join(require('node:path').dirname(process.argv[3]), 'docker-empty'),
        ).length === 0,
        'DOCKER_CONFIG_NOT_EMPTY',
      );
      return JSON.parse(
        execFileSync(
          '/usr/bin/docker',
          [
            '--host',
            'unix:///var/run/docker.sock',
            '--config',
            require('node:path').join(
              require('node:path').dirname(process.argv[3]),
              'docker-empty',
            ),
            type,
            'inspect',
            name,
            '--format',
            format,
          ],
          {
            env: { PATH: '/usr/bin:/bin', HOME: require('node:path').dirname(process.argv[3]) },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10000,
          },
        ),
      );
    };
    const file = require('./storage-policy.cjs').admissionPath(process.argv[3]);
    insist(file.startsWith('/tmp/') && file.endsWith('/admission.json'), 'ADMISSION_PATH');
    const storage = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
    console.log(
      JSON.stringify(collect(process.argv[2], inspect, process.argv[4] === '--stopped', storage)),
    );
  } catch {
    console.error('REHEARSAL_INVENTORY_FAILED');
    process.exitCode = 1;
  }
}
module.exports = { collect };
