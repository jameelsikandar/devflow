'use client';
import { useEffect, useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, body, ApiError } from '@/lib/client';
import { revalidationSchema, revalidationMessages } from '@/lib/github-revalidation';
import { Button } from './ui/button';
import './github-operational-health.css';
type Props = { workspaceId: string; projectId: string; connectionId?: string; admin: boolean };
export function GitHubConnectionRevalidation(props: Props) {
  if (!props.admin || !props.connectionId) return null;
  return (
    <Revalidation
      key={`${props.workspaceId}:${props.projectId}:${props.connectionId}`}
      {...props}
      connectionId={props.connectionId}
    />
  );
}
function Revalidation({ workspaceId, projectId, connectionId }: Props & { connectionId: string }) {
  const headingId = useId();
  const explanationId = useId();
  const [now, setNow] = useState(Date.now);
  const check = useMutation({
    retry: false,
    networkMode: 'always',
    mutationFn: async () => {
      try {
        const data = revalidationSchema.parse(
          await api<unknown>(
            `github/repositories/${encodeURIComponent(connectionId)}/revalidate?workspaceId=${encodeURIComponent(workspaceId)}`,
            { method: 'POST', body: body({}), cache: 'no-store' },
          ),
        );
        if (
          data.scope.workspaceId !== workspaceId ||
          data.scope.projectId !== projectId ||
          data.scope.connectionId !== connectionId
        )
          throw new ApiError('Scope unavailable', 404);
        setNow(Date.now());
        return data;
      } catch (error) {
        if (error instanceof ApiError)
          throw new ApiError('Connection revalidation unavailable', error.status);
        throw new Error('Connection revalidation unavailable');
      }
    },
  });
  const data = check.data;
  useEffect(() => {
    if (!data?.retryAt || Date.parse(data.retryAt) <= Date.now()) return;
    const deadline = Date.parse(data.retryAt);
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= deadline) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [data?.retryAt]);
  const waiting = !!data?.retryAt && Date.parse(data.retryAt) > now;
  const message = data ? revalidationMessages[data.code] : null;
  const denied = check.error instanceof ApiError && [401, 403, 404].includes(check.error.status);
  return (
    <section
      className="github-operational-health"
      aria-labelledby={headingId}
      aria-busy={check.isPending}
    >
      <header>
        <h4 id={headingId}>Connection revalidation</h4>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-describedby={explanationId}
          disabled={check.isPending || waiting}
          onClick={() => {
            setNow(Date.now());
            check.mutate();
          }}
        >
          {check.isPending
            ? 'Checking GitHub access…'
            : check.isError
              ? 'Try revalidation again'
              : 'Revalidate GitHub access'}
        </Button>
      </header>
      <p id={explanationId}>
        Explicit external read · Checks configured enrichment only with its authorizing
        administrator’s account. If enrichment is unset, checks your own OAuth account without
        enabling it. Another member’s credential is never borrowed.
      </p>
      <p>
        No reconnection, credential rotation, webhook change, task update or rule execution is
        performed.
      </p>
      {check.isPending && <p role="status">Checking authorization and repository access…</p>}
      {check.isError && (
        <p role="alert">
          {denied
            ? 'Revalidation is unavailable for this account or connection.'
            : check.error instanceof ApiError && check.error.status === 429
              ? 'Too many checks. Wait before trying again.'
              : 'Unable to complete revalidation. Try again explicitly.'}
        </p>
      )}
      {data && message && (
        <div role="status">
          <strong
            className="github-health-badge"
            data-tone={data.state === 'VALID' ? 'healthy' : 'neutral'}
          >
            {message.title}
          </strong>
          <p>{message.detail}</p>
          <p>
            Checked{' '}
            <time dateTime={data.checkedAt}>{new Date(data.checkedAt).toLocaleString()}</time> ·{' '}
            {data.authorizationSource === 'CONFIGURED_ENRICHMENT'
              ? 'Configured enrichment authorization'
              : data.authorizationSource === 'REQUESTING_ADMIN'
                ? 'Your OAuth account only'
                : 'No OAuth account checked'}
          </p>
          {data.retryAt && (
            <p>
              {data.retrySource === 'LOCAL_COOLDOWN'
                ? 'Recorded local cooldown until'
                : 'Observed provider retry deadline'}{' '}
              <time dateTime={data.retryAt}>{new Date(data.retryAt).toLocaleString()}</time>.{' '}
              {waiting ? 'Wait before retrying.' : 'You may explicitly check again.'}
            </p>
          )}
          <p>
            Point-in-time diagnostic only. Repository identity and all connection settings remain
            unchanged. Results are cleared when you leave this scope.
          </p>
        </div>
      )}
    </section>
  );
}
