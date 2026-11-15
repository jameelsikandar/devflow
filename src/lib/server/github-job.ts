import { planGitHubAutomation } from './github-automation';
import { db } from './db';
import {
  githubEventFacts,
  parseStoredGitHubEvent,
  GitHubProcessingError,
} from './github-event-handlers';
import { enrichGitHubEvent, enrichmentStillAuthorized } from './github-enrichment';
import { publishGitHubFacts } from './github-activity';
import {
  claimGitHubDelivery,
  completeGitHubDelivery,
  failGitHubDelivery,
  githubWorkerLog,
  renewGitHubLease,
  type WorkerOptions,
} from './github-processing';
export async function processNextGitHubDelivery(options: WorkerOptions) {
  const lease = await claimGitHubDelivery(options);
  if (!lease) return false;
  let renewing = false;
  const heartbeat = setInterval(
    () => {
      if (renewing) return;
      renewing = true;
      void renewGitHubLease(lease, options.leaseSeconds)
        .catch(() => {})
        .finally(() => {
          renewing = false;
        });
    },
    Math.max(1000, Math.floor((options.leaseSeconds * 1000) / 3)),
  );
  try {
    const source = await db.gitHubWebhookDelivery.findUniqueOrThrow({
      where: { id: lease.id },
      include: { connection: true },
    });
    if (
      parseStoredGitHubEvent(source.event, source.dataVersion, source.data).repositoryId !==
      source.connection.repositoryId
    )
      throw new GitHubProcessingError('STORED_REPOSITORY_MISMATCH');
    const enriched = await enrichGitHubEvent(source, source.connection);
    const processed = await completeGitHubDelivery(lease, async (tx, context) => {
      const authorized =
        !enriched.auth || (await enrichmentStillAuthorized(tx, context.connection, enriched.auth));
      const facts = authorized
        ? enriched.facts
        : githubEventFacts(
            context.delivery.event,
            context.delivery.dataVersion,
            context.delivery.data,
          );
      await publishGitHubFacts(
        tx,
        context,
        facts,
        authorized ? enriched.code : 'ENRICHMENT_AUTH_CHANGED',
      );
      await planGitHubAutomation(tx, context);
    });
    githubWorkerLog(processed ? 'processed' : 'lease_lost_or_cancelled', lease);
  } catch (error) {
    await failGitHubDelivery(lease, error, options);
    githubWorkerLog(
      'failed',
      lease,
      error instanceof GitHubProcessingError ? error.code : 'WORKER_TRANSIENT_FAILURE',
    );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
