import type { Prisma } from '@prisma/client';
import { HttpError } from './errors';
import { evaluateGitHubWorkflow } from '../github-workflows';
/** Internal read helper. Callers must authorize a human or hold the fenced worker locks. */
export async function evaluateStoredGitHubWorkflow(
  tx: Prisma.TransactionClient,
  actor: { workspaceId: string },
  projectId: string,
  observationId: string,
  includeDisabled = false,
  archived = false,
  processingDeliveryId?: string,
) {
  const o = await tx.gitHubObservation.findFirst({
    where: {
      id: observationId,
      projectId,
      object: { workspaceId: actor.workspaceId, projectId },
    },
    include: {
      object: true,
      connection: true,
      delivery: true,
      evidence: {
        include: {
          link: {
            include: {
              task: {
                select: {
                  id: true,
                  projectId: true,
                  number: true,
                  title: true,
                  status: true,
                  version: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!o) throw new HttpError(404, 'Observation not found');
  const data = o.data;
  const local =
    data !== null && typeof data === 'object' && !Array.isArray(data) && 'webhook' in data
      ? data.webhook
      : data;
  const rules = await tx.gitHubWorkflowRule.findMany({
    where: { workspaceId: actor.workspaceId, projectId, deletedAt: null },
  });
  // Duplicate semantic webhook facts are not a second actionable event. Enrichment is never a trigger.
  const duplicate =
    local !== null &&
    (await tx.gitHubObservation.findFirst({
      where: {
        objectId: o.objectId,
        OR: [{ receivedAt: { lt: o.receivedAt } }, { receivedAt: o.receivedAt, id: { lt: o.id } }],
        AND: [
          {
            OR: [
              { data: { equals: local as Prisma.InputJsonValue } },
              { data: { path: ['webhook'], equals: local as Prisma.InputJsonValue } },
            ],
          },
        ],
      },
      select: { id: true },
    }));
  const evaluation = evaluateGitHubWorkflow(
    {
      observationId: o.id,
      connectionId: o.connectionId,
      repositoryId: o.repositoryId,
      objectKey: o.object.key,
      kind: o.object.kind,
      event: o.delivery.event,
      dataVersion: o.delivery.dataVersion,
      data: local,
      currentData: o.object.currentData,
      sourceUpdatedAt: o.object.sourceUpdatedAt?.toISOString() ?? null,
      disconnected: !!o.connection.disconnectedAt,
      archived: archived,
      processed:
        o.delivery.state === 'PROCESSED' ||
        (o.delivery.id === processingDeliveryId && o.delivery.state === 'PROCESSING'),
      duplicate: !!duplicate,
      incomplete: o.incomplete,
      unresolvedRefs: o.unresolvedRefs,
      tasks: o.evidence.filter((e) => e.link.task.projectId === projectId).map((e) => e.link.task),
    },
    rules,
    includeDisabled,
  );
  return { observation: o, rules, evaluation };
}
