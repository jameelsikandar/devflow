import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  normalizeGitHubEvent,
  repositoryCommand,
  verifyGitHubSignature,
} from '../src/lib/server/github-webhook';

const secret = 'a separate webhook secret';
const raw = Buffer.from('{"repository":{"id":123},"message":"é"}');
const sign = (body: Buffer) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
describe('GitHub webhook signature and minimization', () => {
  it('verifies exact bytes, including whitespace and Unicode', () => {
    expect(verifyGitHubSignature(raw, sign(raw), secret)).toBe(true);
    expect(verifyGitHubSignature(Buffer.concat([raw, Buffer.from('\n')]), sign(raw), secret)).toBe(
      false,
    );
    expect(verifyGitHubSignature(raw, sign(raw), 'wrong secret')).toBe(false);
  });
  it.each([
    null,
    '',
    'sha1=abc',
    'sha256=abc',
    `sha256=${'g'.repeat(64)}`,
    `sha256=${'0'.repeat(66)}`,
  ])('rejects malformed or missing signature %s', (signature) => {
    expect(verifyGitHubSignature(raw, signature, secret)).toBe(false);
  });
  it('uses the documented GitHub HMAC test vector', () => {
    expect(
      verifyGitHubSignature(
        Buffer.from('Hello, World!'),
        'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
        "It's a Secret to Everybody",
      ),
    ).toBe(true);
  });
  it('drops ping hook configuration, sender and repository private metadata', () => {
    expect(
      normalizeGitHubEvent(
        'ping',
        Buffer.from(
          JSON.stringify({
            repository: { id: 123, private: true },
            sender: { email: 'private@example.com' },
            hook: { config: { secret: 'never retain' } },
          }),
        ),
      ),
    ).toEqual({ event: 'ping', repositoryId: '123', data: { repositoryId: '123' } });
  });
  it('keeps bounded commit identifiers/references and explicitly marks truncated lists', () => {
    const result = normalizeGitHubEvent(
      'push',
      Buffer.from(
        JSON.stringify({
          repository: { id: 123 },
          ref: 'refs/heads/main',
          before: 'a'.repeat(40),
          after: 'b'.repeat(40),
          commits: Array.from({ length: 101 }, () => ({
            id: 'c'.repeat(40),
            message: 'DEV-12 dev-12: private commit narrative',
            author: { email: 'private@example.com' },
          })),
        }),
      ),
    );
    expect(result.data).toMatchObject({ commitCount: 101, commitsTruncated: true });
    expect(result.data.commits).toHaveLength(100);
    expect(JSON.stringify(result.data)).not.toContain('private');
    expect(result.data.commits?.[0]).toEqual({ sha: 'c'.repeat(40), taskRefs: ['DEV-12'] });
  });
  it('retains PR facts and task references without retaining body, title or profile', () => {
    const result = normalizeGitHubEvent(
      'pull_request',
      Buffer.from(
        JSON.stringify({
          repository: { id: 123 },
          action: 'closed',
          pull_request: {
            number: 7,
            state: 'closed',
            merged: true,
            merge_commit_sha: 'd'.repeat(40),
            title: 'DEV-7 private title',
            body: 'private body DEV-8',
            user: { email: 'private@example.com' },
          },
        }),
      ),
    );
    expect(result.data).toEqual({
      repositoryId: '123',
      action: 'closed',
      number: 7,
      state: 'closed',
      merged: true,
      mergeCommitSha: 'd'.repeat(40),
      taskRefs: ['DEV-7', 'DEV-8'],
    });
  });
  it('normalizes issue and CI facts', () => {
    expect(
      normalizeGitHubEvent(
        'issues',
        Buffer.from(
          JSON.stringify({
            repository: { id: 123 },
            action: 'opened',
            issue: { number: 8, state: 'open', title: 'DEV-9 fix', body: null },
          }),
        ),
      ).data,
    ).toEqual({
      repositoryId: '123',
      action: 'opened',
      number: 8,
      state: 'open',
      taskRefs: ['DEV-9'],
    });
    expect(
      normalizeGitHubEvent(
        'workflow_run',
        Buffer.from(
          JSON.stringify({
            repository: { id: 123 },
            action: 'completed',
            workflow_run: {
              id: 9,
              head_sha: 'a'.repeat(40),
              status: 'completed',
              conclusion: 'success',
            },
          }),
        ),
      ).data,
    ).toMatchObject({ runId: 9, conclusion: 'success' });
  });
  it('rejects unsupported events, malformed JSON, missing records and unsafe IDs', () => {
    expect(() => normalizeGitHubEvent('member', raw)).toThrow('Unsupported');
    expect(() => normalizeGitHubEvent('ping', Buffer.from('{'))).toThrow('Invalid webhook JSON');
    expect(() =>
      normalizeGitHubEvent(
        'pull_request',
        Buffer.from('{"repository":{"id":123},"action":"opened"}'),
      ),
    ).toThrow('Missing');
    expect(() =>
      normalizeGitHubEvent('ping', Buffer.from('{"repository":{"id":9007199254740992}}')),
    ).toThrow();
  });
  it('rejects arbitrary URLs/path traversal and extra connection command keys', () => {
    for (const repository of [
      'https://github.com/a/b',
      '../repo',
      'a/b/../../user',
      'a/b?token=secret',
    ])
      expect(repositoryCommand.safeParse({ projectId: 'p', repository }).success).toBe(false);
    expect(
      repositoryCommand.safeParse({
        projectId: 'p',
        repository: 'owner/repo',
        workspaceId: 'foreign',
      }).success,
    ).toBe(false);
  });
});
