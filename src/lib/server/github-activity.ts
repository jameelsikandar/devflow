import { canonicalTaskReference } from '../task-reference';
import type { Prisma } from '@prisma/client';
import { shouldAdvanceProjection, type GitHubFact } from './github-event-handlers';
import type { GitHubPublishContext } from './github-processing';
import { linkGitHubTasks, resolveGitHubTaskReferences } from './github-task-links';
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
export async function publishGitHubFacts(
  tx: Prisma.TransactionClient,
  context: GitHubPublishContext,
  input: GitHubFact[],
  enrichmentCode = 'LOCAL_ONLY',
) {
  const { connection: c, delivery } = context;
  const byIdentity = new Map<string, GitHubFact>();
  for (const fact of input) {
    const key = `${fact.kind}:${fact.key}`;
    const existing = byIdentity.get(key);
    byIdentity.set(
      key,
      existing ? { ...existing, refs: [...new Set([...existing.refs, ...fact.refs])] } : fact,
    );
  }
  const facts = [...byIdentity.values()];
  if (!facts.length) return;
  // Bulk writes keep the fenced project transaction bounded even for 300 commits.
  await tx.gitHubObject.createMany({
    data: facts.map((f) => ({
      workspaceId: c.workspaceId,
      projectId: c.projectId,
      repositoryId: c.repositoryId,
      kind: f.kind,
      key: f.key,
      ...(f.kind === 'COMMIT' ? { currentData: json(f.projectionData ?? f.data) } : {}),
    })),
    skipDuplicates: true,
  });
  const objects = await tx.gitHubObject.findMany({
    where: {
      projectId: c.projectId,
      repositoryId: c.repositoryId,
      OR: facts.map((f) => ({ kind: f.kind, key: f.key })),
    },
  });
  const lookup = new Map(objects.map((o) => [`${o.kind}:${o.key}`, o]));
  const tasks = await resolveGitHubTaskReferences(
    tx,
    c,
    facts.flatMap((f) => f.refs),
  );
  const rows = facts.map((f) => ({
    projectId: c.projectId,
    repositoryId: c.repositoryId,
    connectionId: c.id,
    deliveryId: delivery.id,
    objectId: lookup.get(`${f.kind}:${f.key}`)!.id,
    data: json(f.data),
    receivedAt: delivery.receivedAt,
    incomplete: f.incomplete,
    enrichmentCode,
    unresolvedRefs: [...new Set(f.refs.map((r) => canonicalTaskReference(r) ?? r))].filter(
      (r) => !tasks.has(r),
    ),
  }));
  await tx.gitHubObservation.createMany({ data: rows, skipDuplicates: true });
  const observations = await tx.gitHubObservation.findMany({
    where: { deliveryId: delivery.id, connectionId: c.id },
    select: { id: true, objectId: true },
  });
  const observed = new Map(observations.map((o) => [o.objectId, o.id]));
  await linkGitHubTasks(
    tx,
    c,
    facts.map((f) => {
      const objectId = lookup.get(`${f.kind}:${f.key}`)!.id;
      return { objectId, observationId: observed.get(objectId)!, refs: f.refs };
    }),
    tasks,
  );
  for (const fact of facts) {
    const object = lookup.get(`${fact.kind}:${fact.key}`)!;
    if (shouldAdvanceProjection(object.sourceUpdatedAt, fact.sourceUpdatedAt))
      await tx.gitHubObject.update({
        where: { id: object.id },
        data: {
          currentData: json(fact.projectionData ?? fact.data),
          sourceUpdatedAt: new Date(fact.sourceUpdatedAt!),
        },
      });
  }
}
