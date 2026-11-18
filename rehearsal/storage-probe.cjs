/* eslint-disable @typescript-eslint/no-require-imports -- Isolated admission probe. */
'use strict';
const fs = require('node:fs');
const { names, insist } = require('./policy.cjs');
const { receipt } = require('./storage-policy.cjs');
function inspectEmpty(io, runId, value) {
  receipt(value, runId);
  insist(io.existsSync('/.dockerenv') && io.realpathSync('/work') === '/work', 'PROBE_CONTAINER');
  const mounts = io
    .readFileSync('/proc/self/mountinfo', 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split(' '));
  insist(
    mounts.some((m) => m[4] === '/' && m[5].split(',').includes('ro')),
    'PROBE_ROOT',
  );
  insist(!mounts.some((m) => /^\/(home|root|work)(\/|$)/.test(m[4])), 'PROBE_HOST_MOUNT');
  insist(
    !io.existsSync('/var/run/docker.sock') && !io.existsSync('/run/docker.sock'),
    'DOCKER_SOCKET',
  );
  for (const role of ['data', 'evidence']) {
    const path = `/admission/${role}`;
    const mount = mounts.find((m) => m[4] === path);
    insist(mount, 'PROBE_MOUNT');
    const separator = mount.indexOf('-');
    insist(
      separator > 5 &&
        ['ext4', 'xfs', 'btrfs'].includes(mount[separator + 1]) &&
        mount[3].endsWith(`/volumes/${value.volumes[role].name}/_data`),
      'VOLUME_FILESYSTEM',
    );
    insist(io.readdirSync(path).length === 0, 'VOLUME_NOT_EMPTY');
  }
}
function admit(io, runId, value) {
  inspectEmpty(io, runId, value); // Both directories checked before the first write.
  for (const role of ['data', 'evidence'])
    io.writeFileSync(
      `/admission/${role}/.rehearsal-storage.json`,
      JSON.stringify({ runId, nonce: value.nonce, role, name: value.volumes[role].name }),
      { flag: 'wx', mode: 0o444 },
    );
  io.writeFileSync('/admission/evidence/storage-admission.json', JSON.stringify(value), {
    flag: 'wx',
    mode: 0o444,
  });
  io.chownSync('/admission/evidence', 1000, 1000);
}
if (require.main === module) {
  try {
    insist(process.argv.length === 3, 'ARGUMENTS');
    names(process.argv[2]);
    const value = JSON.parse(fs.readFileSync(0, 'utf8'));
    admit(fs, process.argv[2], value);
    console.log('REHEARSAL_STORAGE_EMPTY_VERIFIED');
  } catch {
    console.error('REHEARSAL_STORAGE_ADMISSION_FAILED');
    process.exitCode = 1;
  }
}
module.exports = { inspectEmpty, admit };
