'use client';
import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api, ApiError } from '@/lib/client';
import {
  HEALTH_REFRESH_MS,
  operationalHealthSchema,
  operationalGuidance,
  operationalSnapshotState,
  workerHealthLabels,
} from '@/lib/github-operational-health';
import { Button } from './ui/button';
import './github-operational-health.css';
type Props = { workspaceId: string; projectId: string; connectionId?: string; admin: boolean };
const accessDenied = (error: unknown) =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);
function Timestamp({ value }: { value: string | null }) {
  return value ? (
    <time dateTime={value}>{new Date(value).toLocaleString()}</time>
  ) : (
    <>Not observed</>
  );
}
export function GitHubOperationalHealth(props: Props) {
  if (!props.admin) return null;
  if (!props.connectionId)
    return (
      <section className="github-operational-health" aria-label="GitHub operational health">
        <h4>Operational health</h4>
        <p>Select a connected repository to inspect worker and queue evidence.</p>
      </section>
    );
  return (
    <HealthSummary
      key={`${props.workspaceId}:${props.projectId}:${props.connectionId}`}
      {...props}
      connectionId={props.connectionId}
    />
  );
}
function HealthSummary({ workspaceId, projectId, connectionId }: Props & { connectionId: string }) {
  const headingId = useId();
  const [now, setNow] = useState(Date.now);
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = setInterval(update, 15000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  const health = useQuery({
    queryKey: ['github-health', workspaceId, projectId, connectionId],
    queryFn: async ({ signal }) => {
      try {
        const raw = await api<unknown>(
          `github/repositories/${encodeURIComponent(connectionId)}/health?workspaceId=${encodeURIComponent(workspaceId)}`,
          { signal, cache: 'no-store' },
        );
        const data = operationalHealthSchema.parse(raw);
        if (
          data.scope.workspaceId !== workspaceId ||
          data.scope.projectId !== projectId ||
          data.scope.connectionId !== connectionId
        )
          throw new ApiError('Health scope unavailable', 404);
        if (!signal.aborted) {
          setNow(Date.now());
          setVerified(true);
        }
        return data;
      } catch (error) {
        if (!signal.aborted && accessDenied(error)) setVerified(false);
        if (signal.aborted) throw error;
        // Keep provider/database text out of both the UI and the client error cache.
        if (error instanceof ApiError)
          throw new ApiError('Operational health request failed', error.status);
        throw new Error('Operational health response unavailable');
      }
    },
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: (query) => (accessDenied(query.state.error) ? false : HEALTH_REFRESH_MS),
    refetchOnWindowFocus: (query) => !accessDenied(query.state.error),
  });
  const denied = accessDenied(health.error);
  // Cached data is not an authorization check. Revalidate it on every mount.
  const data = verified && health.isFetchedAfterMount && !denied ? health.data : undefined;
  const snapshot = data ? operationalSnapshotState(data.asOf, now) : 'current';
  const stale = health.isError || snapshot !== 'current';
  const state =
    data &&
    (data.scope.disconnected
      ? 'DISCONNECTED'
      : data.scope.archived
        ? 'PROJECT_ARCHIVED'
        : data.worker.state);
  const label = state ? workerHealthLabels[state] : null;
  const guidance = data
    ? [...new Set(data.diagnostics.map((d) => d.code))].filter((code) =>
        Object.hasOwn(operationalGuidance, code),
      )
    : [];
  return (
    <section
      className="github-operational-health"
      aria-labelledby={headingId}
      aria-busy={health.isFetching}
    >
      <header>
        <h4 id={headingId}>Operational health</h4>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={health.isFetching}
          onClick={() => {
            setNow(Date.now());
            void health.refetch();
          }}
        >
          <RefreshCw
            size={14}
            aria-hidden="true"
            className={health.isFetching ? 'spin' : undefined}
          />
          Refresh operational health
        </Button>
      </header>
      {!health.isFetchedAfterMount && !health.isError && (
        <p role="status">Loading operational health…</p>
      )}
      {health.isError && (
        <p role="alert">
          {denied
            ? 'Operational health is unavailable for this account or connection.'
            : 'Could not refresh operational health. Try refreshing again.'}
        </p>
      )}
      {data && label && (
        <>
          <div className="github-health-worker">
            <strong
              className="github-health-badge"
              data-tone={
                !stale && (state === 'HEALTHY_IDLE' || state === 'HEALTHY_ACTIVE')
                  ? 'healthy'
                  : 'neutral'
              }
            >
              {stale ? 'Last observed: ' : ''}
              {label.title}
            </strong>
            <p>{label.description}</p>
          </div>
          <p className="github-health-asof">
            {stale ? 'Last known snapshot' : 'Snapshot'}: <Timestamp value={data.asOf} />
            {health.isFetching ? ' · Refreshing…' : ''}
          </p>
          {stale && (
            <p role="status" className="github-health-stale">
              {snapshot === 'clock_difference'
                ? 'The snapshot timestamp differs from this device’s clock. Refresh to verify.'
                : 'Snapshot stale. Refresh to confirm current health; these are last known values.'}
            </p>
          )}
          {data.deliveries.total === 0 && data.automation.total === 0 && (
            <p>
              No deliveries or workflow executions recorded for this connection yet. Worker health
              uses independent evidence.
            </p>
          )}
          <div className="github-health-metrics">
            <section aria-label="Delivery queue health">
              <h5>Delivery queue</h5>
              <dl>
                <dt>Ready now</dt>
                <dd>{data.deliveries.ready}</dd>
                <dt>Scheduled later</dt>
                <dd>{data.deliveries.scheduled}</dd>
                <dt>Processing</dt>
                <dd>{data.deliveries.processing}</dd>
                <dt>Expired leases</dt>
                <dd>{data.deliveries.expiredLeases}</dd>
                <dt>Oldest ready receipt</dt>
                <dd>
                  <Timestamp value={data.deliveries.oldestReadyAt} />
                </dd>
                <dt>Next scheduled</dt>
                <dd>
                  <Timestamp value={data.deliveries.nextScheduledAt} />
                </dd>
              </dl>
            </section>
            <section aria-label="Delivery retry and failure health">
              <h5>Retries &amp; delivery outcomes</h5>
              <dl>
                <dt>Pending</dt>
                <dd>{data.deliveries.pending}</dd>
                <dt>Failed total</dt>
                <dd>{data.deliveries.failed}</dd>
                <dt>Dead letters</dt>
                <dd>{data.deliveries.deadLettered}</dd>
                <dt>Processed</dt>
                <dd>{data.deliveries.processed}</dd>
                <dt>Cancelled</dt>
                <dd>{data.deliveries.cancelled}</dd>
              </dl>
              <p>
                Scheduled work can include retry backoff. Failed totals include retryable failures
                and dead letters.
              </p>
            </section>
            <section aria-label="Automation execution health">
              <h5>Automation executions</h5>
              <dl>
                <dt>Ready now</dt>
                <dd>{data.automation.ready}</dd>
                <dt>Scheduled later</dt>
                <dd>{data.automation.scheduled}</dd>
                <dt>Applied</dt>
                <dd>{data.automation.applied}</dd>
                <dt>Skipped</dt>
                <dd>{data.automation.skipped}</dd>
                <dt>Conflicted</dt>
                <dd>{data.automation.conflicted}</dd>
                <dt>Failed</dt>
                <dd>{data.automation.failed}</dd>
              </dl>
            </section>
          </div>
          <details>
            <summary>Worker evidence timestamps</summary>
            <dl className="github-health-times">
              <dt>Heartbeat</dt>
              <dd>
                <Timestamp value={data.worker.lastHeartbeatAt} />
              </dd>
              <dt>Completed poll</dt>
              <dd>
                <Timestamp value={data.worker.lastPollAt} />
              </dd>
              <dt>Attempt progress</dt>
              <dd>
                <Timestamp value={data.worker.lastAttemptProgressAt} />
              </dd>
              <dt>Bounded heartbeat</dt>
              <dd>
                <Timestamp value={data.worker.lastBoundedHeartbeatAt} />
              </dd>
            </dl>
            <p>
              Attempt progress is not proof of a successful task change. Counts overlap; do not sum
              all metrics.
            </p>
          </details>
          {guidance.length > 0 && (
            <details>
              <summary>Operational guidance ({guidance.length})</summary>
              <ul>
                {guidance.map((code) => (
                  <li key={code}>{operationalGuidance[code]}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="github-health-note">
            Read only · Refreshing does not start a worker, retry a delivery or execute a rule.
            Review individual deliveries below and automation outcomes in workflow execution
            history.
          </p>
        </>
      )}
    </section>
  );
}
