'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, body } from '@/lib/client';
import {
  executionStates,
  automationReasons,
  type WorkflowExecutionPage,
} from '@/lib/github-automation';
import { statuses, statusNames } from '@/lib/types';
import {
  workflowTriggers,
  workflowPreviewReasons,
  type WorkflowDefinition,
  type WorkflowRule,
  type WorkflowPreview,
} from '@/lib/github-workflows';
import { Dialog } from './ui/dialog';
import { Button } from './ui/button';

type Rule = WorkflowRule & {
  deletedAt: string | null;
  automationEnabledAt?: string | null;
  automationEnabledVersion?: number | null;
};
type Page = {
  rules: Rule[];
  archived: boolean;
  connections: { id: string; repositoryFullName: string; disconnectedAt: string | null }[];
  observations: {
    id: string;
    number: string;
    action: string;
    repository: string;
    receivedAt: string;
    disconnected: boolean;
    state: string;
  }[];
  total: number;
  offset: number;
  hasMore: boolean;
};
type History = {
  items: {
    id: string;
    version: number;
    operation: string;
    createdAt: string;
    snapshot: { name: string };
  }[];
  hasMore: boolean;
  offset: number;
};
const initial: WorkflowDefinition = {
  name: '',
  connectionId: null,
  trigger: 'PR_MERGED',
  targetStatus: 'DONE',
  enabled: false,
  priority: 100,
};
export function GitHubWorkflowSettings({
  projectId,
  projectName,
  scope,
  onClose,
  openTask,
}: {
  projectId: string;
  projectName: string;
  scope: (path: string) => string;
  onClose: () => void;
  openTask?: (id: string) => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [form, setForm] = useState<WorkflowDefinition>(initial);
  const [observationId, setObservationId] = useState('');
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [notice, setNotice] = useState('');
  const [executions, setExecutions] = useState<WorkflowExecutionPage | null>(null);
  const [executionState, setExecutionState] = useState('');
  const inFlight = useRef(false);
  const requestIds = useRef(new Map<string, string>());
  const path = `projects/${projectId}/github-workflows`;
  const endpoint = useCallback((suffix = '') => scope(path + suffix), [scope, path]);
  const load = useCallback(() => api<Page>(`${endpoint()}&offset=${offset}`), [endpoint, offset]);
  useEffect(() => {
    let active = true;
    void load()
      .then((p) => {
        if (active) {
          setPage(p);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, [load]);
  async function perform(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function mutate(
    method: 'POST' | 'PATCH' | 'DELETE',
    rule: Rule | null,
    definition?: WorkflowDefinition,
  ) {
    if (
      definition?.enabled &&
      !window.confirm(
        `Enable GitHub automation for “${definition.name}”? Future verified PR events may change linked task statuses to ${statusNames[definition.targetStatus]}. Historical events will not execute. Saving an enabled rule starts a new activation boundary.`,
      )
    )
      return;
    const payload = {
      ...(definition?.enabled ? { automationConfirmed: true } : {}),
      ...(definition ? { definition } : {}),
      ...(rule ? { expectedVersion: rule.version } : {}),
    };
    const key = JSON.stringify({ method, id: rule?.id, payload });
    const requestId = requestIds.current.get(key) ?? crypto.randomUUID();
    requestIds.current.set(key, requestId);
    await api(endpoint(rule ? `/${rule.id}` : ''), {
      method,
      body: body({ ...payload, requestId }),
    });
    requestIds.current.delete(key);
    setPreview(null);
    setHistory(null);
    setEditing(null);
    setForm(initial);
    setNotice(
      'Rule configuration saved. Only future eligible events can execute; previews remain read-only.',
    );
    setPage(await load());
  }
  const selected = page?.observations.find((o) => o.id === observationId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`GitHub workflow rules · ${projectName}`}
      description="Manage confirmed GitHub status automation, read-only previews and execution history."
      wide
    >
      <div className="github-workflow-settings">
        <p className="workflow-safety" role="note">
          Rules are disabled by default. Confirmed enabled rules can change task statuses for future
          verified PR events. Dry runs never change tasks; historical events do not execute.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}{' '}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  setPage(await load());
                })
              }
            >
              Reload settings
            </Button>
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {!page ? (
          !error && <p role="status">Loading project settings…</p>
        ) : (
          <>
            {page.archived && (
              <p role="note">This project is archived. Restore it before changing rules.</p>
            )}
            <section aria-labelledby="workflow-rules-title">
              <h3 id="workflow-rules-title">Rules</h3>
              <p>
                Lower priority numbers win. Different targets at the same winning priority block the
                preview.
              </p>
              {!page.rules.length ? (
                <p>No rules yet. New rules are disabled by default.</p>
              ) : (
                <ul className="workflow-rule-list">
                  {page.rules.map((r) => (
                    <li key={r.id}>
                      <div>
                        <strong>{r.name}</strong>
                        <p>
                          {workflowTriggers[r.trigger]} → {statusNames[r.targetStatus]} · Priority{' '}
                          {r.priority} · v{r.version}
                        </p>
                        <small>
                          {r.connectionId
                            ? (page.connections.find((c) => c.id === r.connectionId)
                                ?.repositoryFullName ?? 'Unavailable repository')
                            : 'All connected repositories in this project'}{' '}
                          ·{' '}
                          {!r.enabled
                            ? 'Disabled'
                            : r.automationEnabledAt && r.automationEnabledVersion === r.version
                              ? 'Enabled · automation'
                              : 'Preview only · confirmation required'}
                        </small>
                      </div>
                      <div className="workflow-actions">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || page.archived}
                          onClick={() => {
                            setEditing(r);
                            setForm({
                              name: r.name,
                              connectionId: r.connectionId,
                              trigger: r.trigger,
                              targetStatus: r.targetStatus,
                              enabled: r.enabled,
                              priority: r.priority,
                            });
                          }}
                        >
                          Edit {r.name}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={
                            busy ||
                            page.archived ||
                            !!(
                              !r.enabled &&
                              r.connectionId &&
                              page.connections.find((c) => c.id === r.connectionId)?.disconnectedAt
                            )
                          }
                          onClick={() =>
                            void perform(() =>
                              mutate('PATCH', r, {
                                name: r.name,
                                connectionId: r.connectionId,
                                trigger: r.trigger,
                                targetStatus: r.targetStatus,
                                enabled:
                                  !r.enabled ||
                                  !r.automationEnabledAt ||
                                  r.automationEnabledVersion !== r.version,
                                priority: r.priority,
                              }),
                            )
                          }
                        >
                          {r.enabled &&
                          r.automationEnabledAt &&
                          r.automationEnabledVersion === r.version
                            ? 'Disable'
                            : 'Enable'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || page.archived}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete rule “${r.name}”? Its audit history will be retained.`,
                              )
                            )
                              void perform(() => mutate('DELETE', r));
                          }}
                        >
                          Delete {r.name}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <form
              className="workflow-form"
              onSubmit={(e) => {
                e.preventDefault();
                void perform(() => mutate(editing ? 'PATCH' : 'POST', editing, form));
              }}
            >
              <h3>{editing ? `Edit rule · version ${editing.version}` : 'Create rule'}</h3>
              <div className="form-grid">
                <label>
                  Rule name
                  <input
                    required
                    maxLength={100}
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </label>
                <label>
                  Repository
                  <select
                    value={form.connectionId ?? ''}
                    onChange={(e) => setForm({ ...form, connectionId: e.target.value || null })}
                  >
                    <option value="">All connected repositories in this project</option>
                    {page.connections.map((c) => (
                      <option key={c.id} value={c.id} disabled={!!c.disconnectedAt}>
                        {c.repositoryFullName}
                        {c.disconnectedAt ? ' (disconnected)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Trigger
                  <select
                    value={form.trigger}
                    onChange={(e) =>
                      setForm({ ...form, trigger: e.target.value as WorkflowDefinition['trigger'] })
                    }
                  >
                    {Object.entries(workflowTriggers).map(([key, text]) => (
                      <option key={key} value={key}>
                        {text}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Target task status
                  <select
                    value={form.targetStatus}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        targetStatus: e.target.value as WorkflowDefinition['targetStatus'],
                      })
                    }
                  >
                    {statuses.map((s) => (
                      <option key={s} value={s}>
                        {statusNames[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Priority
                  <input
                    type="number"
                    min={0}
                    max={10000}
                    required
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                  />
                </label>
                <label className="workflow-check">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  />
                  Enable automation (requires confirmation)
                </label>
              </div>
              <div className="workflow-actions">
                <Button type="submit" size="sm" disabled={busy || page.archived}>
                  {busy
                    ? 'Working…'
                    : editing
                      ? 'Save rule'
                      : form.enabled
                        ? 'Create rule'
                        : 'Create disabled rule'}
                </Button>
                {editing && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditing(null);
                      setForm(initial);
                    }}
                  >
                    Cancel edit
                  </Button>
                )}
              </div>
            </form>
            <section aria-labelledby="workflow-preview-title">
              <h3 id="workflow-preview-title">Dry-run preview</h3>
              <p>
                Choose a stored PR observation. Only its original webhook facts and task-link
                evidence are evaluated. Events older than seven days are blocked.
              </p>
              {!page.observations.length ? (
                <p>
                  No stored pull request observations. Commit observations cannot trigger a PR rule.
                </p>
              ) : (
                <>
                  <label>
                    Pull request observation
                    <select
                      value={observationId}
                      onChange={(e) => {
                        setObservationId(e.target.value);
                        setPreview(null);
                      }}
                    >
                      <option value="">Choose an observation</option>
                      {page.observations.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.repository} #{o.number} · {o.action} ·{' '}
                          {new Date(o.receivedAt).toLocaleString()}
                          {o.disconnected ? ' · disconnected' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selected && (
                    <small>
                      Delivery: {selected.state} · Repository: {selected.repository}
                    </small>
                  )}
                </>
              )}
              {page.total > 25 && (
                <div className="workflow-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !offset}
                    onClick={() => {
                      setOffset(Math.max(0, offset - 25));
                      setObservationId('');
                      setPreview(null);
                    }}
                  >
                    Previous events
                  </Button>
                  <span>
                    {offset + 1}–{Math.min(offset + 25, page.total)} of {page.total}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !page.hasMore}
                    onClick={() => {
                      setOffset(offset + 25);
                      setObservationId('');
                      setPreview(null);
                    }}
                  >
                    Next events
                  </Button>
                </div>
              )}
              <label className="workflow-check">
                <input
                  type="checkbox"
                  checked={includeDisabled}
                  onChange={(e) => {
                    setIncludeDisabled(e.target.checked);
                    setPreview(null);
                  }}
                />
                Include disabled rules in hypothetical preview
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !selected}
                onClick={() =>
                  void perform(async () => {
                    setPreview(null);
                    setPreview(
                      await api<WorkflowPreview>(endpoint('/preview'), {
                        method: 'POST',
                        body: body({ observationId, includeDisabled }),
                      }),
                    );
                  })
                }
              >
                Preview only
              </Button>
              {preview && (
                <div className="workflow-result" role="status">
                  <strong>Dry run — no tasks changed</strong>
                  {preview.blockers.map((code) => (
                    <p key={code}>{workflowPreviewReasons[code] ?? code}</p>
                  ))}
                  {preview.warnings.map((w) => (
                    <p key={w}>{w}</p>
                  ))}
                  {preview.transition ? (
                    <p>
                      <strong>
                        {preview.transition.reference} — {preview.transition.title}
                      </strong>
                      : {statusNames[preview.transition.from]} →{' '}
                      {statusNames[preview.transition.to]}
                      {preview.transition.alreadyAtTarget ? ' (already at target)' : ''} · task v
                      {preview.transition.taskVersion}, rule v{preview.transition.ruleVersion}
                      {preview.transition.hypothetical ? ' · hypothetical' : ''}
                    </p>
                  ) : (
                    !preview.blockers.length && <p>No eligible rule matches this observation.</p>
                  )}
                  <ul>
                    {preview.matches.map((r) => (
                      <li key={r.id}>
                        {r.name} · v{r.version} · Priority {r.priority}:{' '}
                        {
                          (
                            {
                              MATCH: 'Matches',
                              DISABLED: 'Disabled',
                              OTHER_TRIGGER: 'Different trigger',
                              OTHER_CONNECTION: 'Different repository connection',
                            } as Record<string, string>
                          )[r.reason]
                        }
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
            <section aria-label="Automation execution history">
              <h3>Automation executions</h3>
              <label>
                Execution state
                <select
                  value={executionState}
                  onChange={(e) => {
                    setExecutionState(e.target.value);
                    setExecutions(null);
                  }}
                >
                  <option value="">All outcomes</option>
                  {executionStates.map((s) => (
                    <option key={s} value={s}>
                      {s.toLowerCase()}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    setExecutions(
                      await api<WorkflowExecutionPage>(
                        `${endpoint('/executions')}${executionState ? `&state=${executionState}` : ''}`,
                      ),
                    );
                  })
                }
              >
                Refresh execution history
              </Button>
              {executions && (
                <>
                  {!executions.items.length && (
                    <p>
                      No executions in this view. Old processed observations are never queued
                      automatically.
                    </p>
                  )}
                  <ul className="workflow-rule-list">
                    {executions.items.map((e) => (
                      <li key={e.id}>
                        <strong>
                          {e.state.toLowerCase()} · {e.ruleName}
                          {e.ruleVersion ? ` (v${e.ruleVersion})` : ''}
                        </strong>
                        <p>
                          {automationReasons[e.reason ?? ''] ??
                            workflowPreviewReasons[e.reason ?? ''] ??
                            'Execution is pending.'}
                        </p>
                        <p>
                          {e.taskReference ?? 'No single target'}
                          {e.taskTitle ? ` — ${e.taskTitle}` : ''}
                          {e.previousStatus && e.targetStatus
                            ? ` · ${statusNames[e.previousStatus]} → ${statusNames[e.targetStatus]}`
                            : ''}
                          {e.expectedTaskVersion !== null
                            ? ` · task v${e.expectedTaskVersion}`
                            : ''}
                        </p>
                        <small>
                          {e.repository} · {new Date(e.createdAt).toLocaleString()} · {e.attempts}{' '}
                          attempts{e.disconnected ? ' · disconnected' : ''}
                        </small>
                        <div className="workflow-actions">
                          {e.prUrl && (
                            <a href={e.prUrl} target="_blank" rel="noopener noreferrer">
                              View PR #{e.prNumber}
                            </a>
                          )}
                          {e.taskId && openTask && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                onClose();
                                openTask(e.taskId!);
                              }}
                            >
                              Open {e.taskReference ?? 'task'}
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="workflow-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !executions.offset}
                      onClick={() =>
                        void perform(async () => {
                          setExecutions(
                            await api<WorkflowExecutionPage>(
                              `${endpoint('/executions')}&offset=${Math.max(0, executions.offset - 25)}${executionState ? `&state=${executionState}` : ''}`,
                            ),
                          );
                        })
                      }
                    >
                      Previous executions
                    </Button>
                    <span>{executions.total} outcomes</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !executions.hasMore}
                      onClick={() =>
                        void perform(async () => {
                          setExecutions(
                            await api<WorkflowExecutionPage>(
                              `${endpoint('/executions')}&offset=${executions.offset + 25}${executionState ? `&state=${executionState}` : ''}`,
                            ),
                          );
                        })
                      }
                    >
                      Next executions
                    </Button>
                  </div>
                </>
              )}
            </section>
            <section aria-label="Rule audit history">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    setHistory(await api<History>(endpoint('/history')));
                  })
                }
              >
                View configuration history
              </Button>
              {history && (
                <>
                  <ul>
                    {history.items.map((h) => (
                      <li key={h.id}>
                        {h.snapshot.name} · {h.operation.toLowerCase()} · v{h.version} ·{' '}
                        {new Date(h.createdAt).toLocaleString()}
                      </li>
                    ))}
                  </ul>
                  {!history.items.length && <p>No configuration changes yet.</p>}
                  <div className="workflow-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !history.offset}
                      onClick={() =>
                        void perform(async () => {
                          setHistory(
                            await api<History>(
                              `${endpoint('/history')}&offset=${Math.max(0, history.offset - 25)}`,
                            ),
                          );
                        })
                      }
                    >
                      Previous changes
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !history.hasMore}
                      onClick={() =>
                        void perform(async () => {
                          setHistory(
                            await api<History>(
                              `${endpoint('/history')}&offset=${history.offset + 25}`,
                            ),
                          );
                        })
                      }
                    >
                      Next changes
                    </Button>
                  </div>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </Dialog>
  );
}
