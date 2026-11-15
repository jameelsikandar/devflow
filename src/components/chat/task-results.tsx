'use client';
import {
  friendlyField,
  friendlyDate,
  record,
  taskReference,
  verifiedTask,
  type ChatContext,
} from '@/lib/chat-presentation';
export function TaskResults({
  rows,
  context,
  label = 'Retrieved tasks',
}: {
  rows: unknown[];
  context: ChatContext;
  label?: string;
}) {
  const items = rows.map(record);
  return (
    <div className="chat-table-scroll" role="region" tabIndex={0} aria-label={label}>
      <table>
        <thead>
          <tr>
            <th scope="col">Task</th>
            {!context.projectId && <th scope="col">Project</th>}
            <th scope="col">Status</th>
            <th scope="col">Priority</th>
            <th scope="col">Assignee</th>
            <th scope="col">Due date (UTC)</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => {
            const ref = typeof item.number === 'number' ? taskReference(item.number) : '';
            const task = verifiedTask(context, ref);
            return (
              <tr key={index}>
                <td>
                  {task && context.openTask ? (
                    <button
                      type="button"
                      className="chat-task-reference"
                      onClick={() => context.openTask?.(task.id)}
                    >
                      {ref}
                    </button>
                  ) : (
                    ref
                  )}{' '}
                  {String(item.title ?? '')}
                </td>
                {!context.projectId && (
                  <td>
                    {typeof item.projectName === 'string'
                      ? item.projectName
                      : friendlyField('projectId', item.projectId, context)}
                  </td>
                )}
                <td>{friendlyField('status', item.status, context)}</td>
                <td>{friendlyField('priority', item.priority, context)}</td>
                <td>
                  {item.assigneeId === null
                    ? 'Unassigned'
                    : typeof item.assigneeName === 'string'
                      ? item.assigneeName
                      : friendlyField('assigneeId', item.assigneeId, context)}
                </td>
                <td>{friendlyDate(item.dueDate)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!items.length && <p className="chat-result-empty">No tasks matched this query.</p>}
    </div>
  );
}
