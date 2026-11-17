'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, body } from '@/lib/client';
import { Button } from './ui/button';
import { GitHubOperationalHealth } from './github-operational-health';
type Delivery = {
  id: string;
  event: string;
  state: string;
  attempts: number;
  errorCode: string | null;
  deadLetteredAt: string | null;
  availableAt: string;
  leaseExpiresAt: string | null;
};
type Status = {
  counts: Record<string, number>;
  items: Delivery[];
  total: number;
  hasMore: boolean;
  enrichmentEnabled: boolean;
  disconnected: boolean;
};
type Activity = {
  id: string;
  kind: string;
  key: string;
  sourceUpdatedAt: string | null;
  observations: {
    id: string;
    incomplete: boolean;
    enrichmentCode: string;
    unresolvedRefs: string[];
  }[];
  links: { task: { id: string; number: number; title: string } }[];
};
export function GitHubProcessing({
  workspaceId,
  projectId,
  connectionId,
  admin,
  scope,
  openTask,
}: {
  workspaceId: string;
  projectId: string;
  connectionId?: string;
  admin: boolean;
  scope: (route: string) => string;
  openTask?: (id: string) => void;
}) {
  const [state, setState] = useState('');
  const [offset, setOffset] = useState(0);
  const [activityOffset, setActivityOffset] = useState(0);
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ['github-processing', workspaceId, connectionId, state, offset],
    enabled: admin && !!connectionId,
    refetchInterval: 10000,
    queryFn: () =>
      api<Status>(
        `${scope(`github/repositories/${connectionId}/processing`)}&offset=${offset}${state ? `&state=${state}` : ''}`,
      ),
  });
  const activity = useQuery({
    queryKey: ['github-activity', workspaceId, projectId, activityOffset],
    refetchInterval: 10000,
    queryFn: () =>
      api<{ items: Activity[]; total: number; hasMore: boolean }>(
        `${scope(`github/projects/${projectId}/activity`)}&offset=${activityOffset}`,
      ),
  });
  const change = useMutation({
    mutationFn: ({ route, input }: { route: string; input: unknown }) =>
      api(scope(route), { method: 'POST', body: body(input) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['github-processing', workspaceId] }),
  });
  return (
    <section
      className="panel configuration-message"
      aria-label="GitHub event processing"
      style={{ overflowWrap: 'anywhere' }}
    >
      <h3>GitHub event processing</h3>
      <p>
        The separate worker processes this inbox. Linking activity does not change tasks; only
        explicitly enabled, confirmed workflow rules can apply supported status changes.
      </p>
      <GitHubOperationalHealth
        workspaceId={workspaceId}
        projectId={projectId}
        connectionId={connectionId}
        admin={admin}
      />
      {admin && connectionId && (
        <>
          {status.isPending && <p role="status">Loading processing status…</p>}
          {status.isError && <p role="alert">{status.error.message}</p>}
          {status.data && (
            <>
              <p>
                {Object.entries(status.data.counts ?? {})
                  .map(([s, count]) => `${s.toLowerCase()}: ${count}`)
                  .join(' · ') || 'No deliveries yet.'}
              </p>
              <p>
                Optional enrichment reads GitHub using your explicitly authorized OAuth account.
                Disabling it keeps verified webhook processing available.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={change.isPending || status.data.disconnected}
                onClick={() =>
                  change.mutate({
                    route: `github/repositories/${connectionId}/enrichment`,
                    input: { enabled: !status.data.enrichmentEnabled },
                  })
                }
              >
                {status.data.enrichmentEnabled
                  ? 'Disable GitHub enrichment'
                  : 'Authorize enrichment with my GitHub account'}
              </Button>
              <label>
                Delivery state
                <select
                  aria-label="GitHub delivery state"
                  value={state}
                  onChange={(e) => {
                    setState(e.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">All states</option>
                  {['PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'CANCELLED'].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <ul>
                {(status.data.items ?? []).map((d) => (
                  <li key={d.id}>
                    <strong>{d.event}</strong> · {d.state.toLowerCase()} · {d.attempts} attempts{' '}
                    {d.deadLetteredAt && '· dead letter'}
                    {d.errorCode && <span> · {d.errorCode}</span>}
                    {d.state === 'FAILED' && !d.deadLetteredAt && (
                      <small>
                        {' '}
                        · Retry eligible after {new Date(d.availableAt).toLocaleString()}
                      </small>
                    )}
                    {d.state === 'PROCESSING' && d.leaseExpiresAt && (
                      <small> · Lease until {new Date(d.leaseExpiresAt).toLocaleString()}</small>
                    )}
                    {d.state === 'FAILED' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={change.isPending || status.data.disconnected}
                        onClick={() =>
                          change.mutate({
                            route: `github/repositories/${connectionId}/deliveries/${d.id}/retry`,
                            input: {},
                          })
                        }
                      >
                        Retry delivery
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!offset}
                  onClick={() => setOffset(Math.max(0, offset - 25))}
                >
                  Previous deliveries
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!status.data.hasMore}
                  onClick={() => setOffset(offset + 25)}
                >
                  Next deliveries
                </Button>
              </div>
            </>
          )}
        </>
      )}
      {change.isError && <p role="alert">{change.error.message}</p>}
      <h4>Associated GitHub objects</h4>
      {activity.isPending && <p role="status">Loading GitHub activity…</p>}
      {activity.isError && <p role="alert">{activity.error.message}</p>}
      {activity.data && (
        <>
          <ul>
            {(activity.data.items ?? []).map((o) => (
              <li key={o.id}>
                <strong>
                  {o.kind.replaceAll('_', ' ').toLowerCase()}{' '}
                  {o.kind === 'COMMIT' ? o.key.slice(0, 12) : o.key}
                </strong>{' '}
                ·{' '}
                {o.sourceUpdatedAt
                  ? `Source updated ${new Date(o.sourceUpdatedAt).toLocaleString()}`
                  : 'Historical observation; current source state unavailable'}
                {o.links.map(({ task }) => (
                  <Button
                    key={task.id}
                    className="whitespace-normal max-w-full text-left h-auto"
                    size="sm"
                    variant="ghost"
                    disabled={!openTask}
                    onClick={() => openTask?.(task.id)}
                  >
                    DEV-{task.number} — {task.title}
                  </Button>
                ))}
                {o.observations.map((obs) => (
                  <small key={obs.id}>
                    {' '}
                    · {obs.enrichmentCode}
                    {obs.incomplete ? ' · incomplete' : ''}
                    {obs.unresolvedRefs.length
                      ? ` · unresolved: ${obs.unresolvedRefs.join(', ')}`
                      : ''}
                  </small>
                ))}
              </li>
            ))}
          </ul>
          {activity.data.total === 0 && <p>No processed GitHub objects yet.</p>}
          <div>
            <Button
              size="sm"
              variant="ghost"
              disabled={!activityOffset}
              onClick={() => setActivityOffset(Math.max(0, activityOffset - 25))}
            >
              Previous objects
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!activity.data.hasMore}
              onClick={() => setActivityOffset(activityOffset + 25)}
            >
              Next objects
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
