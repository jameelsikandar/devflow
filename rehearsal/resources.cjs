/* eslint-disable @typescript-eslint/no-require-imports -- Isolated CommonJS worker/preload tooling. */
'use strict';
// Host-side PURE planner/validator. Does not invoke Docker, signals or cleanup.
const fs = require('node:fs');
const { names, inventory, canonicalInventory, insist } = require('./policy.cjs');
function main(args, input) {
  const [operation, runId] = args;
  insist(args.length === 2, 'ARGUMENTS');
  if (operation === 'plan') return { version: 1, ...names(runId) };
  insist(['validate-start', 'validate-cleanup'].includes(operation), 'COMMAND');
  const data = JSON.parse(input);
  if (operation === 'validate-start') {
    inventory(data, runId);
    return canonicalInventory(data);
  }
  inventory(data.original, runId);
  inventory(data.current, runId, true);
  for (const kind of Object.keys(data.original.resources))
    insist(
      data.current.resources[kind].id === data.original.resources[kind].id,
      'RESOURCE_REPLACED',
    );
  return { version: 1, validated: true, ...names(runId), deletionAuthorized: false };
}
if (require.main === module) {
  try {
    console.log(
      JSON.stringify(
        main(process.argv.slice(2), process.argv[2] === 'plan' ? '' : fs.readFileSync(0, 'utf8')),
      ),
    );
  } catch {
    console.error('REHEARSAL_RESOURCE_VALIDATION_FAILED');
    process.exitCode = 1;
  }
}
module.exports = { main };
