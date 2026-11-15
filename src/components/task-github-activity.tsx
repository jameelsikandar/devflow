'use client';
import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, GitFork as Github, RefreshCw } from 'lucide-react';
import { api } from '@/lib/client';
import {
  githubTaskObjectLabels,
  githubTaskObjectURL,
  type TaskGitHubActivityPage,
} from '@/lib/github-task-activity';
import { Button } from './ui/button';
import './task-github-activity.css';
export function TaskGitHubActivity({
  taskId,
  projectId,
  workspaceId,
  scope,
}: {
  taskId: string;
  projectId: string;
  workspaceId: string;
  scope: (route: string) => string;
}) {
  const headingId = useId();
  const [offset, setOffset] = useState(0);
  const activity = useQuery({
    queryKey: ['task-github', workspaceId, projectId, taskId, offset],
    queryFn: () => {
      const path = scope(`tasks/${taskId}/github`);
      return api<TaskGitHubActivityPage>(
        `${path}${path.includes('?') ? '&' : '?'}offset=${offset}`,
      );
    },
    refetchInterval: 15000,
  });
  return (
    <section
      className="task-github-activity"
      aria-labelledby={headingId}
      aria-busy={activity.isPending}
    >
      <header>
        <div>
          <h3 id={headingId}>
            <Github size={16} aria-hidden="true" />
            GitHub activity
            {activity.data ? <span className="number-badge">{activity.data.total}</span> : null}
          </h3>
          <p>Linked records from GitHub · read only</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Refresh GitHub activity"
          disabled={activity.isFetching}
          onClick={() => void activity.refetch()}
        >
          <RefreshCw
            size={14}
            aria-hidden="true"
            className={activity.isFetching ? 'spin' : undefined}
          />
        </Button>
      </header>
      {activity.isPending && (
        <p role="status" className="task-github-state">
          Loading linked GitHub activity…
        </p>
      )}
      {activity.isError && (
        <div role="alert" className="task-github-state">
          <p>Could not load GitHub activity. {activity.error.message}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void activity.refetch()}>
            Try GitHub activity again
          </Button>
        </div>
      )}
      {activity.data && !activity.isError && (
        <>
          {activity.data.total === 0 ? (
            <p className="task-github-state">No GitHub activity linked to this task yet.</p>
          ) : (
            <ul>
              {activity.data.items.map((item) => {
                const label = Object.hasOwn(githubTaskObjectLabels, item.kind)
                  ? githubTaskObjectLabels[item.kind]
                  : 'GitHub object';
                const identifier = item.kind === 'COMMIT' ? item.key.slice(0, 7) : `#${item.key}`;
                const safeURL = githubTaskObjectURL(item.repositoryName, item.kind, item.key);
                const url = safeURL && item.url === safeURL ? safeURL : null;
                return (
                  <li key={item.id}>
                    <div className="task-github-record">
                      <div className="task-github-object">
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open ${label.toLowerCase()} ${identifier} on GitHub (opens in a new tab)`}
                          >
                            <span>{label}</span>
                            <code>{identifier}</code>
                            <ExternalLink size={12} aria-hidden="true" />
                          </a>
                        ) : (
                          <span>
                            {label} <code>{identifier}</code>
                          </span>
                        )}
                        {item.status && (
                          <span className="tag">
                            {item.statusSource === 'observation' ? 'Observed: ' : ''}
                            {item.status}
                          </span>
                        )}
                      </div>
                      <span className="task-github-repository">
                        {item.repositoryName ?? 'Repository metadata unavailable'}
                      </span>
                      {item.updatedAt && (
                        <small>
                          {item.statusSource === 'source' ? 'Source updated ' : 'Observed '}
                          <time dateTime={item.updatedAt}>
                            {new Date(item.updatedAt).toLocaleString()}
                          </time>
                        </small>
                      )}
                    </div>
                    {item.connection !== 'connected' && (
                      <span className="task-github-disconnected">
                        {item.connection === 'disconnected'
                          ? 'Repository disconnected · historical activity'
                          : 'Repository connection unavailable'}
                      </span>
                    )}
                    {item.incomplete && (
                      <small className="task-github-disconnected">Partial source data</small>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {activity.data.total > activity.data.limit && (
            <nav className="task-github-pagination" aria-label="GitHub activity pages">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={offset === 0 || activity.isFetching}
                onClick={() => setOffset(Math.max(0, offset - activity.data.limit))}
              >
                Previous GitHub activity
              </Button>
              <span>
                {offset + 1}–{offset + activity.data.items.length} of {activity.data.total}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!activity.data.hasMore || activity.isFetching}
                onClick={() => setOffset(offset + activity.data.limit)}
              >
                Next GitHub activity
              </Button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
