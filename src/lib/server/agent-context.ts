import type { Prisma } from '@prisma/client';
import { assertAgentActor, type AgentActor } from './agent-tools';
import { record } from '../chat-presentation';
import type { ToolName } from '../agent';
export async function agentCatalog(
  tx: Prisma.TransactionClient,
  actor: AgentActor,
  name?: string,
  selectedId?: string,
) {
  await assertAgentActor(tx, actor);
  const where = {
    workspaceId: actor.workspaceId,
    archivedAt: null,
    ...(actor.projectId ? { id: actor.projectId } : {}),
  };
  const [projects, projectTotal] = await Promise.all([
    tx.project.findMany({
      where,
      select: { id: true, name: true },
      take: 25,
      orderBy: { id: 'asc' },
    }),
    tx.project.count({ where }),
  ]);
  if (
    selectedId &&
    (!actor.projectId || selectedId === actor.projectId) &&
    !projects.some((p) => p.id === selectedId)
  ) {
    const selected = await tx.project.findFirst({
      where: { ...where, id: selectedId },
      select: { id: true, name: true },
    });
    if (selected) projects.push(selected);
  }
  if (name && projectTotal > projects.length) {
    const matches = await tx.project.findMany({
      where: { ...where, name: { equals: name, mode: 'insensitive' } },
      select: { id: true, name: true },
      take: 2,
    });
    const merged = new Map([...projects, ...matches].map((p) => [p.id, p]));
    return { projects: [...merged.values()], projectTotal, catalogComplete: false };
  }
  return { projects, projectTotal, catalogComplete: projectTotal === projects.length };
}
/** Authorization is rechecked even when task data is reused within a single run. */
export async function canReuseAgentRead(
  tx: Prisma.TransactionClient,
  actor: AgentActor,
  name: ToolName,
  output: unknown,
) {
  await assertAgentActor(tx, actor);
  const result = record(output),
    ids = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id === 'string') ids.add(id);
  };
  add(actor.projectId);
  add(result.projectId);
  add(record(result.project).id);
  add(record(result.context).projectId);
  add(record(result.scope).projectId);
  for (const item of Array.isArray(result.items) ? result.items : [])
    add(name === 'listProjects' ? record(item).id : record(item).projectId);
  const related = record(result.projectContext);
  add(record(related.context).projectId);
  for (const item of Array.isArray(related.items) ? related.items : []) add(record(item).projectId);
  if (actor.projectId && [...ids].some((id) => id !== actor.projectId)) return false;
  return (
    !ids.size ||
    (await tx.project.count({
      where: { id: { in: [...ids] }, workspaceId: actor.workspaceId, archivedAt: null },
    })) === ids.size
  );
}
