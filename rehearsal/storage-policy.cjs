/* eslint-disable @typescript-eslint/no-require-imports -- Pure rehearsal policy. */
'use strict';
const { names, insist } = require('./policy.cjs');
const hex = /^[a-f0-9]{64}$/;
const image = /^sha256:[a-f0-9]{64}$/;
function volume(meta, runId, role, start, end) {
  names(runId);
  insist(meta && hex.test(meta.name) && meta.id === meta.name, 'ANONYMOUS_VOLUME_REQUIRED');
  insist(
    meta.driver === 'local' && meta.optionCount === 0 && meta.scope === 'local',
    'VOLUME_BACKING',
  );
  insist(
    meta.labels?.['devflow.rehearsal'] === runId &&
      meta.labels?.['devflow.rehearsal.role'] === role,
    'VOLUME_OWNER',
  );
  const created = Date.parse(meta.createdAt);
  insist(Number.isFinite(created) && created >= start && created <= end, 'VOLUME_FRESHNESS');
  return meta;
}
function receipt(v, runId) {
  names(runId);
  insist(v?.version === 2 && v.runId === runId && hex.test(v.nonce), 'STORAGE_RECEIPT');
  const start = Date.parse(v.startedAt),
    end = Date.parse(v.admittedAt);
  insist(Number.isFinite(start) && end >= start && end - start <= 120000, 'ADMISSION_WINDOW');
  for (const role of ['data', 'evidence']) volume(v.volumes?.[role], runId, role, start, end);
  insist(v.volumes.data.name !== v.volumes.evidence.name, 'VOLUME_ALIAS');
  insist(
    v.probe?.name === names(runId).admission &&
      hex.test(v.probe.id) &&
      image.test(v.probe.imageId) &&
      v.probe.emptyVerified === true,
    'EMPTY_PROOF',
  );
  insist(image.test(v.postgresImageId), 'POSTGRES_IMAGE');
  return v;
}
function admissionPath(file) {
  insist(
    typeof file === 'string' &&
      /^\/tmp\/devflow-worker-rehearsal\.[A-Za-z0-9]{8}\/admission\.json$/.test(file),
    'ADMISSION_PATH',
  );
  return file;
}
function absent(list, name) {
  // Listing success is established by the caller; inspection errors never mean absent.
  insist(
    Array.isArray(list) && list.every((s) => typeof s === 'string'),
    'RESOURCE_LIST_INDETERMINATE',
  );
  insist(!list.includes(name), 'RESOURCE_ALREADY_EXISTS');
}
function provenance(p) {
  insist(
    p?.approved === true &&
      /^node:22\.[0-9.]+-bookworm@sha256:[a-f0-9]{64}$/.test(p.nodeImage) &&
      /^postgres:18[^@]*@sha256:[a-f0-9]{64}$/.test(p.postgresImage) &&
      /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(p.pnpmIntegrity) &&
      typeof p.reviewEvidence === 'string' &&
      p.reviewEvidence.length >= 10,
    'PROVENANCE_APPROVAL_REQUIRED',
  );
  return p;
}
function canonical(v) {
  const volumes = {};
  for (const role of ['data', 'evidence']) {
    const m = v.volumes[role];
    volumes[role] = {
      name: m.name,
      id: m.id,
      driver: m.driver,
      optionCount: m.optionCount,
      scope: m.scope,
      createdAt: m.createdAt,
      labels: { 'devflow.rehearsal': v.runId, 'devflow.rehearsal.role': role },
    };
  }
  return {
    version: 2,
    runId: v.runId,
    nonce: v.nonce,
    startedAt: v.startedAt,
    admittedAt: v.admittedAt,
    volumes,
    probe: {
      name: v.probe.name,
      id: v.probe.id,
      imageId: v.probe.imageId,
      emptyVerified: v.probe.emptyVerified,
    },
    postgresImageId: v.postgresImageId,
  };
}
module.exports = { volume, receipt, absent, provenance, canonical, admissionPath };
