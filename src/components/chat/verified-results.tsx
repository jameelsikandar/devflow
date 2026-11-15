'use client';
import { record, type ChatContext, type ChatToolEvent } from '@/lib/chat-presentation';
import { TaskResults } from './task-results';
/** Actual persisted tool data, never a replacement/generated assistant answer. */
export function VerifiedResults({
  events,
  context,
}: {
  events: ChatToolEvent[];
  context: ChatContext;
}) {
  const event = events
    .filter(
      (e) =>
        e.name === 'listTasks' && !record(e.output).error && Array.isArray(record(e.output).items),
    )
    .at(-1);
  if (!event) return null;
  const output = record(event.output),
    related = record(output.projectContext),
    scope = record(output.scope);
  const rows = Array.isArray(related.items) ? related.items : (output.items as unknown[]);
  const page = Array.isArray(related.items) ? related : output;
  const total = page.total;
  const projectId = scope.projectId ?? record(output.context).projectId;
  const scopeName = projectId
    ? String(
        record(output.context).projectName ??
          context.data.projects.find((p) => p.id === projectId)?.name ??
          'selected project',
      )
    : 'workspace active projects';
  const offset = typeof page.offset === 'number' ? page.offset : 0;
  const more =
    typeof page.hasMore === 'boolean' ? page.hasMore : offset + rows.length < Number(total);
  return (
    <section className="agent-verified-results" aria-label="Verified task data">
      <h3>Retrieved task data</h3>
      <p>
        {scope.kind === 'mine'
          ? `${output.total} matching tasks assigned to you.`
          : `${output.total} matching tasks.`}{' '}
        Scope: {scopeName}.
        {Array.isArray(related.items)
          ? ` ${String(related.projectName ?? 'This project')} contains ${related.total} tasks; ${related.unassignedTotal} unassigned. These project tasks are not personal assignment matches.`
          : ''}
      </p>
      <TaskResults rows={rows} context={context} label="Verified tasks" />
      <small>
        Showing {rows.length} of {String(total)}, offset {offset}.{' '}
        {more ? 'Partial matching result; more pages are available.' : 'Complete matching result.'}{' '}
        Retrieved records; the assistant did not finish its answer.
      </small>
    </section>
  );
}
