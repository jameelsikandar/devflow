/* eslint-disable @typescript-eslint/no-require-imports -- Isolated CommonJS worker/preload tooling. */
'use strict';
const { randomUUID, createHmac } = require('node:crypto');
const { insist } = require('./policy.cjs');
const { migrationReady } = require('./database.cjs');
const { until } = require('./processes.cjs');
const secret = 'synthetic-worker-rehearsal-secret';
async function baseline(ctx) {
  const { db, config } = ctx;
  await migrationReady(db);
  insist((await db.gitHubConnection.count()) === 0, 'OAUTH_RECORD_PRESENT');
  const email = `rehearsal-${config.runId}@example.invalid`;
  const users = await db.user.findMany({ take: 2, select: { id: true, email: true } });
  insist(users.length <= 1 && users.every((u) => u.email === email), 'FOREIGN_FIXTURE');
  if (users.length) return users[0];
  // Fresh migration-only database, not a copied development/recovery database.
  insist(
    (await db.workspace.count()) === 0 && (await db.project.count()) === 0,
    'NONEMPTY_DATABASE',
  );
  return db.user.create({
    data: { email, name: 'Synthetic rehearsal owner', passwordHash: 'not-a-login' },
  });
}
async function makeFixture(ctx, scenario) {
  const { db, config, app } = ctx;
  const user = await baseline(ctx);
  const workspace = await db.workspace.create({
    data: {
      name: `rehearsal-${config.runId}`,
      members: { create: { userId: user.id, role: 'OWNER' } },
    },
  });
  const project = await db.project.create({
    data: { workspaceId: workspace.id, name: `rehearsal-${config.runId}-${scenario}` },
  });
  const connection = await db.gitHubRepositoryConnection.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      repositoryId: '123',
      repositoryFullName: 'synthetic/rehearsal',
      connectedById: user.id,
      encryptedWebhookSecret: app('crypto').encrypt(secret),
    },
  });
  const task = await db.task.create({
    data: {
      projectId: project.id,
      title: 'Synthetic worker target',
      description: 'Must remain unchanged',
      status: 'TODO',
      priority: 'HIGH',
      position: 1234,
    },
  });
  const actor = { userId: user.id, workspaceId: workspace.id, name: 'Synthetic rehearsal owner' };
  const options = app('github-processing').workerOptions.parse({
    connectionId: connection.id,
    concurrency: 1,
    leaseSeconds: 30,
    maxAttempts: 3,
    pollMs: 1000,
  });
  const health = () =>
    app('github-operational-health').githubOperationalHealth(actor, connection.id);
  const ingest = async (event, value, deliveryId = randomUUID()) => {
    const raw = Buffer.from(JSON.stringify(value));
    const headers = new Headers({
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    });
    const receipt = await app('github-repositories').ingestGitHubDelivery(
      connection.id,
      raw,
      headers,
    );
    const delivery = await db.gitHubWebhookDelivery.findUnique({
      where: { connectionId_deliveryId: { connectionId: connection.id, deliveryId } },
    });
    return { receipt, delivery, deliveryId, value, event };
  };
  const push = () =>
    ingest('push', {
      repository: { id: 123 },
      ref: 'refs/heads/rehearsal',
      before: 'a'.repeat(40),
      after: randomUUID().replaceAll('-', '').padEnd(40, 'a'),
      commits: [
        {
          id: randomUUID().replaceAll('-', '').padEnd(40, 'b'),
          message: `Synthetic DEV-${task.number}`,
        },
      ],
    });
  const merged = async () => {
    const result = await app('github-workflows').mutateGitHubWorkflowRule(
      actor,
      project.id,
      'CREATE',
      {
        requestId: randomUUID(),
        automationConfirmed: true,
        definition: {
          name: 'Synthetic merged rule',
          connectionId: connection.id,
          trigger: 'PR_MERGED',
          targetStatus: 'DONE',
          enabled: true,
          priority: 100,
        },
      },
    );
    const rule = result.rule;
    // Actual time must advance beyond activation; no synthetic future event time.
    await until(() => Date.now() > Date.parse(rule.automationEnabledAt), 'RULE_ACTIVATION', 5000);
    return ingest('pull_request', {
      repository: { id: 123 },
      action: 'closed',
      pull_request: {
        number: 1,
        title: `Synthetic DEV-${task.number}`,
        body: '',
        state: 'closed',
        merged: true,
        merge_commit_sha: null,
        updated_at: new Date().toISOString(),
      },
    });
  };
  return {
    db,
    actor,
    project,
    connection,
    task,
    options,
    health,
    ingest,
    push,
    merged,
    current: () => db.task.findUniqueOrThrow({ where: { id: task.id } }),
    delivery: (id) =>
      db.gitHubWebhookDelivery.findUniqueOrThrow({ where: { id, connectionId: connection.id } }),
    objects: () => db.gitHubObject.count({ where: { projectId: project.id } }),
    observations: () => db.gitHubObservation.count({ where: { projectId: project.id } }),
    counts: async () => {
      const scope = { projectId: project.id };
      const [objects, observations, links, evidence, activities, executions, applied, skipped] =
        await Promise.all([
          db.gitHubObject.count({ where: scope }),
          db.gitHubObservation.count({ where: scope }),
          db.gitHubTaskLink.count({ where: scope }),
          db.gitHubTaskLinkEvidence.count({ where: { observation: scope } }),
          db.taskActivity.count({ where: { taskId: task.id } }),
          db.gitHubWorkflowExecution.count({ where: scope }),
          db.gitHubWorkflowExecution.count({ where: { ...scope, state: 'APPLIED' } }),
          db.gitHubWorkflowExecution.count({ where: { ...scope, state: 'SKIPPED' } }),
        ]);
      const linked = await db.gitHubTaskLink.findMany({
        where: scope,
        take: 2,
        select: { taskId: true },
      });
      insist(
        linked.every((l) => l.taskId === task.id),
        'FOREIGN_TASK_LINK',
      );
      return { objects, observations, links, evidence, activities, executions, applied, skipped };
    },
    activities: () =>
      db.taskActivity.count({ where: { taskId: task.id, source: 'GITHUB_AUTOMATION' } }),
  };
}
module.exports = { baseline, makeFixture };
