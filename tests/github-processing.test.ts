import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractTaskReferences,
  githubEventFacts,
  parseStoredGitHubEvent,
  shouldAdvanceProjection,
} from '../src/lib/server/github-event-handlers';
const repositoryId = '123';
export const legacyPush = {
  repositoryId,
  ref: 'refs/heads/main',
  before: 'a'.repeat(40),
  after: 'b'.repeat(40),
  deleted: false,
  commitCount: 1,
  commitsTruncated: false,
  commits: [{ sha: 'c'.repeat(40), taskRefs: ['DEV-12', 'DEV-45'] }],
};
describe('M3.2a versioned normalized events', () => {
  it('preserves existing pending ping and push payloads without fetching raw JSON', () => {
    expect(githubEventFacts('ping', 1, { repositoryId })).toEqual([]);
    expect(githubEventFacts('push', 1, legacyPush)[0]).toMatchObject({
      kind: 'COMMIT',
      key: 'c'.repeat(40),
      refs: ['DEV-12', 'DEV-45'],
    });
  });
  it.each(['issues', 'pull_request'])(
    'accepts legacy %s without pretending to know current source time',
    (event) => {
      expect(
        githubEventFacts(event, 1, {
          repositoryId,
          number: 7,
          action: 'closed',
          state: 'closed',
          merged: true,
          mergeCommitSha: null,
          taskRefs: [],
        })[0].sourceUpdatedAt,
      ).toBeNull();
    },
  );
  it('accepts legacy CI observations and rejects corrupt/unknown formats', () => {
    expect(
      githubEventFacts('workflow_run', 1, {
        repositoryId,
        action: 'completed',
        runId: 1,
        sha: 'a'.repeat(40),
        status: 'completed',
        conclusion: 'success',
      })[0].kind,
    ).toBe('WORKFLOW_RUN');
    expect(() => parseStoredGitHubEvent('ping', 99, { repositoryId })).toThrow(
      'UNSUPPORTED_DATA_VERSION',
    );
    expect(() => parseStoredGitHubEvent('push', 1, {})).toThrow('INVALID_STORED_EVENT');
  });
  it('extracts deduplicated case-normalized task identifiers', () => {
    expect(extractTaskReferences('DEV-12 Fix DEV-45; Closes DEV-18 dev-12, not DEV-0')).toEqual([
      'DEV-12',
      'DEV-45',
      'DEV-18',
    ]);
  });
  it('rejects out-of-order and equal-time projection replacement', () => {
    const current = new Date('2026-11-14T12:00:00Z');
    expect(shouldAdvanceProjection(current, null)).toBe(false);
    expect(shouldAdvanceProjection(current, '2026-11-14T11:00:00Z')).toBe(false);
    expect(shouldAdvanceProjection(current, current.toISOString())).toBe(false);
    expect(shouldAdvanceProjection(current, '2026-11-14T13:00:00Z')).toBe(true);
  });
  it('uses additive DDL with legacy version default and database scope constraints', () => {
    const sql = readFileSync(
      'prisma/migrations/202611140001_github_processing/migration.sql',
      'utf8',
    );
    expect(sql).not.toMatch(/DROP TABLE|TRUNCATE|DELETE FROM|UPDATE "GitHubWebhookDelivery"/i);
    expect(sql).toContain('"dataVersion" INTEGER NOT NULL DEFAULT 1');
    expect(sql).toContain('REFERENCES "Task"("projectId", "id")');
    expect(sql).toContain(
      'REFERENCES "GitHubRepositoryConnection"("projectId", "repositoryId", "id")',
    );
  });
});
it('associates workflow head-commit references when actually present, leaving legacy runs unassigned', () => {
  const data = {
    repositoryId: '123',
    action: 'completed',
    runId: 1,
    sha: 'a'.repeat(40),
    status: 'completed',
    conclusion: 'success',
    taskRefs: ['DEV-12'],
  };
  expect(githubEventFacts('workflow_run', 2, data)[0].refs).toEqual(['DEV-12']);
  const { taskRefs: omitted, ...legacy } = data;
  expect(omitted).toHaveLength(1);
  expect(githubEventFacts('workflow_run', 1, legacy)[0].refs).toEqual([]);
});
