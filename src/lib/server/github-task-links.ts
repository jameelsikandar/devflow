import { canonicalTaskReference } from '../task-reference';
import type { Prisma } from '@prisma/client';
type Scope = { workspaceId: string; projectId: string; repositoryId: string };
export async function resolveGitHubTaskReferences(
  tx: Prisma.TransactionClient,
  scope: Scope,
  references: string[],
) {
  const numbers = [
    ...new Set(
      references
        .map((ref) => canonicalTaskReference(ref))
        .filter((m) => m !== null)
        .map((ref) => Number(ref!.slice(4)))
        .filter((n) => Number.isSafeInteger(n) && n <= 2147483647),
    ),
  ];
  const tasks = numbers.length
    ? await tx.task.findMany({
        where: {
          projectId: scope.projectId,
          project: { workspaceId: scope.workspaceId, archivedAt: null },
          number: { in: numbers },
        },
        select: { id: true, number: true },
      })
    : [];
  return new Map(tasks.map((t) => [`DEV-${t.number}`, t.id]));
}
export async function linkGitHubTasks(
  tx: Prisma.TransactionClient,
  scope: Scope,
  sources: { objectId: string; observationId: string; refs: string[] }[],
  tasks: Map<string, string>,
) {
  const links = new Map<
    string,
    { projectId: string; repositoryId: string; objectId: string; taskId: string }
  >();
  const evidence: { objectId: string; taskId: string; observationId: string }[] = [];
  for (const source of sources)
    for (const ref of new Set(
      source.refs.map(canonicalTaskReference).filter((r): r is string => r !== null),
    )) {
      const taskId = tasks.get(ref);
      if (!taskId) continue;
      links.set(`${source.objectId}:${taskId}`, {
        projectId: scope.projectId,
        repositoryId: scope.repositoryId,
        objectId: source.objectId,
        taskId,
      });
      evidence.push({ objectId: source.objectId, taskId, observationId: source.observationId });
    }
  if (links.size)
    await tx.gitHubTaskLink.createMany({ data: [...links.values()], skipDuplicates: true });
  if (evidence.length)
    await tx.gitHubTaskLinkEvidence.createMany({ data: evidence, skipDuplicates: true });
}
