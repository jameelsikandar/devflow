/* eslint-disable @typescript-eslint/no-require-imports -- Pure test data, no IO. */
'use strict';
const p = require('./policy.cjs');
const run = '20261118T000000Z_1234abcd',
  n = p.names(run);
function fixtureStorage() {
  const volumes = {};
  for (const [role, char] of [
    ['data', 'd'],
    ['evidence', 'e'],
  ]) {
    const name = char.repeat(64);
    volumes[role] = {
      name,
      id: name,
      driver: 'local',
      optionCount: 0,
      scope: 'local',
      createdAt: '2026-11-18T00:00:01Z',
      labels: { 'devflow.rehearsal': run, 'devflow.rehearsal.role': role },
    };
  }
  return {
    version: 2,
    runId: run,
    nonce: 'f'.repeat(64),
    startedAt: '2026-11-18T00:00:00Z',
    admittedAt: '2026-11-18T00:00:02Z',
    volumes,
    probe: {
      name: n.admission,
      id: 'a'.repeat(64),
      imageId: `sha256:${'b'.repeat(64)}`,
      emptyVerified: true,
    },
    postgresImageId: `sha256:${'c'.repeat(64)}`,
  };
}
function fixtureResources() {
  const storage = fixtureStorage(),
    resources = {};
  for (const key of ['network', 'postgres', 'controller', 'data', 'evidence', 'admission']) {
    resources[key] = {
      name: key === 'data' || key === 'evidence' ? storage.volumes[key].name : n[key],
      id: 'a'.repeat(64),
      labels: { 'devflow.rehearsal': run },
    };
  }
  for (const key of ['data', 'evidence']) resources[key] = { ...storage.volumes[key] };
  Object.assign(resources.network, { internal: true, peers: [n.postgres, n.controller] });
  for (const key of ['postgres', 'controller', 'admission'])
    Object.assign(resources[key], {
      networks: [n.network],
      publishedPorts: 0,
      privileged: false,
      running: key !== 'admission',
      readOnlyRootfs: key !== 'postgres',
      user: key === 'admission' ? '0' : key === 'controller' ? 'node' : '',
      pidMode: '',
      ipcMode: 'private',
      capAdd: key === 'admission' ? ['CHOWN'] : [],
      capDrop: ['ALL'],
      networkMode: key === 'admission' ? 'none' : n.network,
      imageId: key === 'postgres' ? storage.postgresImageId : storage.probe.imageId,
      mounts:
        key === 'admission'
          ? ['data', 'evidence'].map((role) => ({
              type: 'volume',
              source: storage.volumes[role].name,
              target: `/admission/${role}`,
              writable: true,
            }))
          : [
              {
                type: 'volume',
                source: storage.volumes[key === 'postgres' ? 'data' : 'evidence'].name,
                target: key === 'postgres' ? '/var/lib/postgresql' : '/evidence',
                writable: true,
              },
            ],
      exitCode: 0,
      command: key === 'postgres' ? p.PG_COMMAND : ['serve'],
    });
  resources.postgres.databaseAlias = true;
  return { version: 1, runId: run, storage, resources };
}
function fixturePins() {
  return {
    approved: true,
    nodeImage: `node:22.23.1-bookworm@sha256:${'1'.repeat(64)}`,
    postgresImage: `postgres:18-alpine@sha256:${'2'.repeat(64)}`,
    pnpmIntegrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
    reviewEvidence: 'SYNTHETIC TEST ONLY',
  };
}
module.exports = { fixtureStorage, fixtureResources, fixturePins, run };
