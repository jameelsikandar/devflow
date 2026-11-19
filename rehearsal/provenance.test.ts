import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
// Pure policy and synthetic fixtures only. No registry, Docker, application or
// database imports. Synthetic approvals below never alter the real manifest.
const { provenance } = require('./storage-policy.cjs');
const { fixturePins } = require('./test-fixtures.cjs');
const digest = '1'.repeat(64);
describe('immutable official Node provenance references', () => {
  it.each(['22-bookworm', '22.23.1-bookworm'])(
    'accepts digest-pinned %s under the existing synthetic approval contract',
    (tag) => {
      const p = { ...fixturePins(), nodeImage: `node:${tag}@sha256:${digest}` };
      expect(provenance(p)).toBe(p);
    },
  );
  it.each([
    'node:22-bookworm',
    `node:22-bookworm@sha256:${'1'.repeat(63)}`,
    `node:22-bookworm@sha256:${'G'.repeat(64)}`,
    `node:22-bookworm@sha512:${digest}`,
    `node:24-bookworm@sha256:${digest}`,
    `node:22-alpine@sha256:${digest}`,
    `other/node:22-bookworm@sha256:${digest}`,
    `evil.example/node:22-bookworm@sha256:${digest}`,
    `node:22-bookworm@sha256:${digest}/extra`,
  ])(
    'rejects unpinned, malformed, foreign-repository or wrong-family reference %s',
    (nodeImage) => {
      expect(() => provenance({ ...fixturePins(), nodeImage })).toThrow(
        'PROVENANCE_APPROVAL_REQUIRED',
      );
    },
  );
});
it('accepts the owner-approved manifest with the exact reviewed amd64 pins', () => {
  const p = JSON.parse(readFileSync(new URL('provenance.json', import.meta.url), 'utf8'));
  expect(p.nodeImage).toBe(
    'node:22-bookworm@sha256:69c6e263db01e9946c7743bbbe9f7b1ba0df384d27ec09e08e5832d6acd3daf3',
  );
  expect(p.postgresImage).toBe(
    'postgres:18-alpine@sha256:fa1b61f5a4844f4d4b73c9b15716cfc75fe70c931f2d32723630f3b900056366',
  );
  expect(p.pnpmIntegrity).toBe(
    'sha512-vWgtXQP+Ul73yf1ngMaITR51asTJyf4AxTh4KCQxDc+Q493E9Tg18G3669UIXkGFXgvLs7YN4qxburieUDbwOw==',
  );
  expect(p.platform).toBe('linux/amd64');
  expect(p.approved).toBe(true);
  expect(provenance(p)).toBe(p);
});

it.each([false, undefined, null, 'true', 1])(
  'rejects an otherwise complete manifest with non-approved approval value %s',
  (approved) => {
    const p = JSON.parse(readFileSync(new URL('provenance.json', import.meta.url), 'utf8'));
    expect(() => provenance({ ...p, approved })).toThrow('PROVENANCE_APPROVAL_REQUIRED');
    expect(p.approved).toBe(true); // Negative cases never mutate the owner-approved manifest.
  },
);
