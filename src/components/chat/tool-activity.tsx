'use client';
import { Check, AlertCircle, ShieldCheck } from 'lucide-react';
import {
  friendlyField,
  record,
  redactDiagnostics,
  toolActivity,
  type ChatContext,
  type ChatToolEvent,
} from '@/lib/chat-presentation';
import { CopyButton } from './copy-button';
import { TaskResults } from './task-results';
export function ToolActivity({
  event,
  context,
  runFailed = false,
}: {
  event: ChatToolEvent;
  context: ChatContext;
  runFailed?: boolean;
}) {
  const activity = toolActivity(event, context);
  const output = record(event.output);
  const items = Array.isArray(output.items) ? output.items.map(record) : [];
  const projectContext = record(output.projectContext);
  const relatedItems = Array.isArray(projectContext.items) ? projectContext.items : [];
  const diagnostic = JSON.stringify(
    redactDiagnostics({ input: event.input, result: event.output }),
    null,
    2,
  );
  return (
    <details className={`chat-tool-activity chat-tool-${activity.state}`}>
      <summary>
        {activity.state === 'error' ? (
          <AlertCircle size={14} />
        ) : activity.state === 'proposal' ? (
          <ShieldCheck size={14} />
        ) : (
          <Check size={14} />
        )}
        <span>
          {runFailed && activity.state === 'proposal'
            ? 'Prepared draft · response interrupted; not saved for approval'
            : activity.summary}
        </span>
      </summary>
      <div className="chat-tool-details">
        <dl>
          <div>
            <dt>Tool</dt>
            <dd>
              <code>{event.name}</code>
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              {activity.state === 'error'
                ? 'Failed'
                : activity.state === 'proposal'
                  ? runFailed
                    ? 'Draft not saved for approval'
                    : 'Awaiting your approval'
                  : 'Completed'}
            </dd>
          </div>
        </dl>
        {activity.state === 'error' && <p role="status">{String(output.error)}</p>}
        {event.name === 'listTasks' && activity.state !== 'error' && (
          <>
            {(items.length > 0 || !relatedItems.length) && (
              <TaskResults rows={items} context={context} />
            )}
            {typeof output.total === 'number' && (
              <p className="agent-footnote">
                Showing {items.length} of {output.total} matching tasks
                {typeof output.offset === 'number' && output.offset > 0
                  ? ` · offset ${output.offset}`
                  : ''}
                {output.hasMore ? ' · more results available' : ''}.
              </p>
            )}
            {output.projectContext && typeof output.projectContext === 'object' ? (
              <section className="agent-project-context">
                <h4>
                  Related project work · {String(projectContext.projectName ?? 'Selected project')}
                </h4>
                <p>
                  Assigned query: 0 matches. This project contains{' '}
                  {String(projectContext.total ?? 0)} tasks;{' '}
                  {String(projectContext.unassignedTotal ?? 0)} unassigned. These are project tasks,
                  not tasks assigned to you.
                </p>
                <TaskResults rows={relatedItems} context={context} label="Related project tasks" />
                <p className="agent-footnote">
                  {String(projectContext.definition ?? '')} Showing {relatedItems.length} of{' '}
                  {String(projectContext.total ?? 0)} project tasks.
                </p>
              </section>
            ) : null}
          </>
        )}
        {event.name === 'listProjects' && (
          <ul>
            {items.map((item, i) => (
              <li key={i}>
                {String(item.name ?? 'Project')}
                {typeof record(item._count).tasks === 'number'
                  ? ` · ${record(item._count).tasks} tasks`
                  : ''}
              </li>
            ))}
          </ul>
        )}
        {event.name === 'getProject' && (
          <p>
            {String(record(output.project).name ?? 'Project')} ·{' '}
            {typeof output.overdue === 'number'
              ? `${output.overdue} overdue tasks`
              : 'Project records retrieved'}
          </p>
        )}
        {event.name === 'getTask' && (
          <dl>
            {[
              'reference',
              'title',
              'projectName',
              'status',
              'priority',
              'assigneeName',
              'startDate',
              'dueDate',
            ]
              .filter((key) => Object.hasOwn(output, key))
              .map((key) => (
                <div key={key}>
                  <dt>{key.replace(/([A-Z])/g, ' $1')}</dt>
                  <dd>{friendlyField(key, output[key], context)}</dd>
                </div>
              ))}
          </dl>
        )}
        {activity.state === 'proposal' && (
          <p>
            {runFailed
              ? 'This request failed before approval previews could be saved. No domain changes were applied.'
              : 'The immutable preview is shown separately above. No changes have been applied by this tool call.'}
          </p>
        )}
        <details>
          <summary>Query filters</summary>
          <dl>
            {Object.entries(record(redactDiagnostics(event.input))).map(([key, value]) => (
              <div key={key}>
                <dt>{key.replace(/([A-Z])/g, ' $1')}</dt>
                <dd>{friendlyField(key, value, context)}</dd>
              </div>
            ))}
          </dl>
        </details>
        <details className="chat-developer-json">
          <summary>Developer Details</summary>
          <CopyButton text={diagnostic} label="Copy tool JSON" />
          <pre tabIndex={0}>{diagnostic}</pre>
        </details>
      </div>
    </details>
  );
}
