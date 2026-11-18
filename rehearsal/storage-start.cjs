/* eslint-disable @typescript-eslint/no-require-imports -- Explicit host start admission. */
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const { insist } = require('./policy.cjs');
const { beforePostgres } = require('./storage-admit.cjs');
if (require.main === module) {
  try {
    const [runId, approve, scope, file] = process.argv.slice(2);
    insist(
      process.argv.length === 6 &&
        approve === '--approve' &&
        scope === 'postgres-start' &&
        file?.startsWith('/tmp/') &&
        file.endsWith('/admission.json'),
      'APPROVAL',
    );
    require('./storage-policy.cjs').admissionPath(file);
    require('./storage-policy.cjs').provenance(
      JSON.parse(fs.readFileSync(path.join(__dirname, 'provenance.json'), 'utf8')),
    );
    const config = path.join(path.dirname(file), 'docker-empty');
    const docker = (args) => {
      insist(fs.readdirSync(config).length === 0, 'DOCKER_CONFIG_NOT_EMPTY');
      return execFileSync(
        '/usr/bin/docker',
        ['--host', 'unix:///var/run/docker.sock', '--config', config, ...args],
        {
          env: { PATH: '/usr/bin:/bin', HOME: path.dirname(file) },
          encoding: 'utf8',
          timeout: 10000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    beforePostgres(runId, value, docker);
    fs.writeFileSync(
      `${file}.postgres-start-ticket`,
      JSON.stringify({ runId, probeId: value.probe.id }),
      { flag: 'wx', mode: 0o600 },
    );
    console.log('REHEARSAL_POSTGRES_START_ADMITTED_ONCE');
  } catch {
    console.error('REHEARSAL_POSTGRES_START_BLOCKED');
    process.exitCode = 1;
  }
}
