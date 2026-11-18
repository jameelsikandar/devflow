/* eslint-disable @typescript-eslint/no-require-imports -- Isolated CommonJS worker/preload tooling. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { environment, inventory, insist } = require('./policy.cjs');
let forbiddenRequests = 0;
let installed = false;
function inspectFilesystem(
  io = fs,
  runtime = {
    cwd: () => process.cwd(),
    node: process.versions.node,
    uid: () => (typeof process.getuid === 'function' ? process.getuid() : 0),
  },
) {
  insist(io.existsSync('/.dockerenv'), 'CONTAINER_REQUIRED');
  const marker = JSON.parse(io.readFileSync('/opt/devflow-rehearsal/image.json', 'utf8'));
  insist(
    marker.version === 1 && marker.root === '/work' && marker.nodeMajor === 22,
    'IMAGE_MARKER',
  );
  insist(
    io.realpathSync(runtime.cwd()) === '/work' && runtime.node.startsWith('22.'),
    'BUILD_ROOT',
  );
  insist(runtime.uid() !== 0, 'NONROOT_REQUIRED');
  // No production .env inspection: reject filenames before ever reading contents.
  for (const dir of ['/work', '/work/prisma'])
    for (const file of io.readdirSync(dir))
      insist(!/^\.env(?:\.|$)/.test(file) || file === '.env.example', 'ENV_FILE_PRESENT');
  insist(
    !io.existsSync('/var/run/docker.sock') && !io.existsSync('/run/docker.sock'),
    'DOCKER_SOCKET',
  );
  const mountInfo = io.readFileSync('/proc/self/mountinfo', 'utf8');
  let rootSeen = false;
  for (const line of mountInfo.trim().split('\n')) {
    const point = line.split(' ')[4];
    if (!point) continue;
    insist(!/^\/(?:home|root|work)(?:\/|$)/.test(point), 'HOST_SOURCE_MOUNT');
    if (point === '/') {
      rootSeen = true;
      insist(line.split(' ')[5].split(',').includes('ro'), 'ROOT_WRITABLE');
    }
  }
  insist(rootSeen, 'ROOT_MOUNT_MISSING');
  return marker;
}
// Dependency injection here is solely for pure tests using fake transports.
function installDeny({ root, transports, prototype, controlSocket, record }) {
  const deny = () => {
    record();
    throw new Error('REHEARSAL_HTTP_FORBIDDEN');
  };
  root.fetch = deny;
  for (const transport of transports)
    for (const method of ['request', 'get', 'connect'])
      if (typeof transport[method] === 'function') transport[method] = deny;
  const original = prototype.connect;
  prototype.connect = function (...args) {
    const arg = Array.isArray(args[0]) ? args[0][0] : args[0];
    const socket = typeof arg === 'string' ? arg : arg?.path;
    if (typeof socket !== 'string' || socket !== controlSocket()) return deny();
    return original.apply(this, args);
  };
}
function blockHttp() {
  if (installed) return;
  installed = true;
  installDeny({
    root: globalThis,
    transports: ['node:http', 'node:https', 'node:http2'].map((name) => require(name)),
    prototype: require('node:net').Socket.prototype,
    controlSocket: socketPath,
    record: () => {
      forbiddenRequests++;
      fs.appendFileSync('/evidence/http-violation', 'HTTP_FORBIDDEN\n', { mode: 0o600 });
    },
  });
}

function socketPath() {
  return path.join('/tmp', `devflow-rehearsal-${environment(process.env).runId}.sock`);
}
function bootstrap(unattested = false) {
  const config = environment(process.env);
  inspectFilesystem();
  require('./storage-policy.cjs').provenance(
    JSON.parse(fs.readFileSync('/work/rehearsal/provenance.json', 'utf8')),
  );
  if (!unattested) {
    const resources = JSON.parse(fs.readFileSync('/evidence/resources.json', 'utf8'));
    inventory(resources, config.runId);
    const admission = require('./storage-policy.cjs').canonical(
      JSON.parse(fs.readFileSync('/evidence/storage-admission.json', 'utf8')),
    );
    insist(
      JSON.stringify(admission) ===
        JSON.stringify(require('./storage-policy.cjs').canonical(resources.storage)),
      'STORAGE_RECEIPT_CHANGED',
    );
  }
  blockHttp();
  return config;
}
module.exports = {
  installDeny,
  bootstrap,
  inspectFilesystem,
  blockHttp,
  socketPath,
  requestCount: () => forbiddenRequests,
};
