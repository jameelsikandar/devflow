/* eslint-disable @typescript-eslint/no-require-imports -- Build-only provenance validation. */
'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { provenance } = require('./storage-policy.cjs');
const { insist } = require('./policy.cjs');
if (require.main === module) {
  try {
    const p = provenance(JSON.parse(fs.readFileSync('/work/rehearsal/provenance.json', 'utf8')));
    const [kind, value] = process.argv.slice(2);
    insist(process.argv.length === 4, 'ARGUMENTS');
    if (kind === '--base') insist(value === p.nodeImage, 'BASE_IMAGE');
    else {
      insist(kind === '--tarball' && value === '/tmp/pnpm-11.9.0.tgz', 'ARGUMENTS');
      insist(
        `sha512-${createHash('sha512').update(fs.readFileSync(value)).digest('base64')}` ===
          p.pnpmIntegrity,
        'PNPM_INTEGRITY',
      );
    }
  } catch {
    console.error('REHEARSAL_PROVENANCE_APPROVAL_REQUIRED');
    process.exitCode = 1;
  }
}
