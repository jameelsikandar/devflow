'use client';
import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/client';
import {
  retentionReportSchema,
  retentionLabels,
  retentionReasonLabels,
  retentionAgeRange,
} from '@/lib/github-retention';
import { Button } from './ui/button';
import './github-operational-health.css';
import './github-retention-report.css';
type Props = { workspaceId: string; projectId: string; admin: boolean };
export function GitHubRetentionReport(props: Props) {
  if (!props.admin) return null;
  return <Report key={`${props.workspaceId}:${props.projectId}`} {...props} />;
}
function Stamp({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : <>None</>;
}
function Report({ workspaceId, projectId }: Props) {
  const heading = useId();
  const [days, setDays] = useState(30);
  const report = useMutation({
    retry: false,
    networkMode: 'always',
    mutationFn: async (window: number) => {
      try {
        const result = retentionReportSchema.parse(
          await api<unknown>(
            `github/projects/${encodeURIComponent(projectId)}/retention?workspaceId=${encodeURIComponent(workspaceId)}&days=${window}`,
            { cache: 'no-store' },
          ),
        );
        if (
          result.scope.workspaceId !== workspaceId ||
          result.scope.projectId !== projectId ||
          result.days !== window
        )
          throw new ApiError('Scope unavailable', 404);
        return result;
      } catch (error) {
        if (error instanceof ApiError)
          throw new ApiError('Retention report unavailable', error.status);
        throw new Error('Retention report unavailable');
      }
    },
  });
  const data = report.data;
  return (
    <section
      className="github-operational-health"
      aria-labelledby={heading}
      aria-busy={report.isPending}
    >
      <header>
        <h4 id={heading}>Retention impact report</h4>
        <div className="github-retention-controls">
          <label>
            Proposed window{' '}
            <select
              aria-label="Proposed retention window"
              value={days}
              disabled={report.isPending}
              onChange={(event) => {
                setDays(Number(event.target.value));
                report.reset();
              }}
            >
              {[7, 30, 90].map((value) => (
                <option key={value} value={value}>
                  {value} days
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={report.isPending}
            onClick={() => report.mutate(days)}
          >
            {report.isPending
              ? 'Calculating impact…'
              : report.isError
                ? 'Try retention report again'
                : 'Generate read-only report'}
          </Button>
        </div>
      </header>
      <p>
        Project-wide preview across current and disconnected repository connections. This proposed
        window is not saved. Nothing is deleted, archived or scheduled.
      </p>
      {!data && !report.isPending && !report.isError && (
        <p>Generate a metadata-only report to inspect age ranges and preservation requirements.</p>
      )}
      {report.isPending && (
        <p role="status">Calculating scoped counts and preservation blockers…</p>
      )}
      {report.isError && (
        <p role="alert">
          {report.error instanceof ApiError && [401, 403, 404].includes(report.error.status)
            ? 'Retention reporting is unavailable for this account or project.'
            : 'Could not calculate retention impact. Try again explicitly; no records were changed.'}
        </p>
      )}
      {data && (
        <>
          <p>
            Snapshot <Stamp value={data.asOf} /> · Strictly older than <Stamp value={data.cutoff} />{' '}
            ({data.days} × 24 hours).{' '}
            {data.scope.archived ? 'Archived project; historical reporting only.' : ''}
          </p>
          {!data.complete && (
            <p role="status">
              Report incomplete: a category exceeded the {data.scanLimit.toLocaleString()}-record
              metadata bound. No totals, age ranges or eligibility conclusions are provided for that
              category.
            </p>
          )}
          {data.complete && data.categories.every((c) => c.total === 0) && (
            <p>No GitHub operational records in this project.</p>
          )}
          <div
            className="github-retention-table-wrap"
            role="region"
            aria-label="Retention impact counts"
            tabIndex={0}
          >
            <table className="github-retention-table">
              <caption>Proposed policy impact — not a cleanup plan</caption>
              <thead>
                <tr>
                  <th scope="col">Record type</th>
                  <th scope="col">Total</th>
                  <th scope="col">Older</th>
                  <th scope="col">Potential candidates</th>
                  <th scope="col">Preserved older</th>
                  <th scope="col">Age range at snapshot</th>
                </tr>
              </thead>
              <tbody>
                {data.categories.map((category) => (
                  <tr key={category.kind}>
                    <th scope="row">{retentionLabels[category.kind].title}</th>
                    {category.complete ? (
                      <>
                        <td>{category.total}</td>
                        <td>{category.older}</td>
                        <td>{category.potentiallyEligible}</td>
                        <td>{category.preservedOlder}</td>
                        <td>
                          {retentionAgeRange(category.oldestAt, category.newestAt, data.asOf)}
                        </td>
                      </>
                    ) : (
                      <td colSpan={5}>
                        At least {category.scannedAtLeast.toLocaleString()} matching records;
                        analysis not calculated.
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.categories
            .filter((c) => c.complete && c.total !== 0)
            .map((category) => (
              <details key={category.kind}>
                <summary>
                  {retentionLabels[category.kind].title} — preservation and age evidence
                </summary>
                <p>
                  {retentionLabels[category.kind].basis} Oldest <Stamp value={category.oldestAt} />{' '}
                  · Newest <Stamp value={category.newestAt} />.
                </p>
                <ul>
                  {category.reasons.map((reason) => (
                    <li key={reason.code}>
                      {retentionReasonLabels[reason.code]}: {reason.count} ·{' '}
                      <Stamp value={reason.oldestAt} /> to <Stamp value={reason.newestAt} />
                    </li>
                  ))}
                </ul>
                <p>
                  Older records with downstream database references:{' '}
                  {category.dependencyProtectedOlder}. This overlaps preservation counts; do not add
                  it to the totals.
                </p>
              </details>
            ))}
          <p>
            Replay receipts, immutable provenance, task associations and execution/idempotency
            history are preserved. Pending, running, failed or unresolved records are not
            candidates. Only older finished, superseded worker evidence may be a hypothetical
            candidate; latest evidence for each connection/mode is kept.
          </p>
          <p>
            Exact-cutoff and future timestamps stay within the proposed window. Evidence age uses
            its source observation time. Counts are records, not processing jobs or estimated disk
            savings. Oversized categories fail closed; no payloads or record identifiers are
            returned.
          </p>
          <p className="github-health-note">
            Strictly read only. Potential candidates are not permission to delete; there is no
            cleanup endpoint, archive operation or scheduler.
          </p>
        </>
      )}
    </section>
  );
}
