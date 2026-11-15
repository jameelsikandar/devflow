'use client';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Clock3,
  FileText,
  History,
  Loader2,
  MessageSquare,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  X,
} from 'lucide-react';
import { api, ApiError, body, useToasts } from '@/lib/client';
import type { Snapshot } from '@/lib/types';
import type { ConversationView, ProposalView, RunView } from '@/lib/agent';
import { RUN_TTL_MS } from '@/lib/agent';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import './agent-manager.css';
import './chat/chat.css';
import { Dialog } from './ui/dialog';
import { VerifiedResults } from './chat/verified-results';
import { planTaskRead, establishedProject } from '@/lib/task-read-plan';
import { providerFailure, providerErrorMessage } from '@/lib/provider-failure';
import { useComposerSize } from './chat/use-composer-size';
import { AIMessage } from './chat/ai-message';
import {
  conversationTitle,
  initialAssistantProject,
  conversationScopeLabel,
  modelLabel,
  taskViewPrompts,
  projectTaskPrompt,
  workspaceTaskPrompt,
} from '@/lib/agent-view';
import { ChatMarkdown } from './chat/markdown';
import { ToolActivity } from './chat/tool-activity';
import { useChatScroll } from './chat/use-chat-scroll';
import {
  friendlyDate,
  friendlyField,
  chatStatusLabels,
  type ChatContext,
} from '@/lib/chat-presentation';

type ConversationSummary = {
  id: string;
  title: string;
  projectId: string | null;
  updatedAt: string;
};
type SprintView = {
  id: string;
  name: string;
  goal: string;
  startDate: string;
  endDate: string;
  project: { name: string };
  tasks: { taskId: string; titleSnapshot: string; statusSnapshot: string }[];
};
type ReportView = {
  id: string;
  title: string;
  content: string;
  periodStart: string;
  periodEnd: string;
  project: { name: string };
  source: Record<string, unknown>;
};
const prompts = [
  [
    'Your current work',
    'My current tasks? Show assigned work first and, if empty, clearly label useful work in this project. Do not call unassigned tasks mine.',
  ],
  ['Progress', 'Summarize current project progress using actual records.'],
  ['Task brief', 'Help me write a task description with acceptance criteria for: '],
  ['Subtasks', 'Read the task and propose actionable child tasks for DEV-'],
  [
    'Sprint plan',
    'Help me plan the next sprint. Ask for dates and goals if missing, inspect current tasks and workload, then propose a realistic sprint.',
  ],
  ['Overdue work', 'List overdue unfinished tasks, including their identifiers and due dates.'],
  ['Priorities', 'Inspect active tasks and propose priority changes with reasons.'],
  [
    'Blockers',
    'Find potential blockers using task dependencies, status and dates. Distinguish facts from risks.',
  ],
  [
    'Assignments',
    'Inspect members and unfinished task counts; recommend assignments based on workload, without assuming skills or availability.',
  ],
  [
    'Weekly report',
    'Draft and propose saving a weekly project report based on actual tasks, stating the UTC reporting period and snapshot limitations.',
  ],
] as const;
const date = friendlyDate;

export function AgentManager({
  data,
  scope,
  refresh,
  openTask,
  selectedProjectId,
}: {
  data: Snapshot;
  scope: (route: string) => string;
  refresh: () => Promise<void>;
  openTask?: (id: string) => void;
  selectedProjectId?: string;
}) {
  const [id, setId] = useState('');
  const [project, setProject] = useState(() => initialAssistantProject(data, selectedProjectId));
  const [prompt, setPrompt] = useState('');
  const composerRef = useComposerSize(prompt);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [panel, setPanel] = useState<'chat' | 'plans'>('chat');
  const [contextOpen, setContextOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const client = useQueryClient();
  const toast = useToasts((s) => s.add);
  const prefix = ['agent', data.workspace.id];
  const config = useQuery({
    queryKey: [...prefix, 'config'],
    queryFn: () =>
      api<{ configured: boolean; model: string; reason: string | null }>(scope('ai/config')),
  });
  const conversations = useQuery({
    queryKey: [...prefix, 'conversations'],
    queryFn: () => api<ConversationSummary[]>(scope('ai/conversations')),
  });
  const detail = useQuery({
    queryKey: [...prefix, id],
    queryFn: () => api<ConversationView>(scope(`ai/conversations/${id}`)),
    enabled: !!id,
    refetchInterval: (q) =>
      q.state.data?.runs.some(
        (r) => r.status === 'RUNNING' && +new Date(r.createdAt) > Date.now() - RUN_TTL_MS,
      )
        ? 2000
        : false,
  });
  const artifactProjectId = id ? detail.data?.projectId : project === 'all' ? null : project;
  const artifacts = useQuery({
    queryKey: [...prefix, 'artifacts', artifactProjectId],
    enabled: !id || !!detail.data,
    queryFn: () =>
      api<{ sprints: SprintView[]; reports: ReportView[] }>(
        `${scope('ai/artifacts')}${artifactProjectId ? `${scope('ai/artifacts').includes('?') ? '&' : '?'}projectId=${encodeURIComponent(artifactProjectId)}` : ''}`,
      ),
  });
  const invalidate = async () => {
    await client.invalidateQueries({ queryKey: prefix });
  };
  const send = useMutation({
    mutationFn: async ({ text, key }: { text: string; key: string }) => {
      let conversationId = id;
      if (!conversationId) {
        const created = await api<{ id: string }>(scope('ai/conversations'), {
          method: 'POST',
          body: body({
            title: conversationTitle(text),
            ...(project !== 'all' ? { projectId: project } : {}),
          }),
        });
        conversationId = created.id;
        setId(created.id);
      }
      return api<RunView>(scope(`ai/conversations/${conversationId}/messages`), {
        method: 'POST',
        body: body({ prompt: text, requestId: key }),
      });
    },
    onSuccess: async () => {
      requestId.current = null;
      setPrompt('');
      await invalidate();
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status < 500) requestId.current = null;
      await invalidate();
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  const decide = useMutation({
    mutationFn: ({
      proposal,
      decision,
    }: {
      proposal: ProposalView;
      decision: 'approve' | 'reject';
    }) =>
      api<{ status: string }>(scope(`ai/proposals/${proposal.id}/decision`), {
        method: 'POST',
        body: body({ decision, previewHash: proposal.previewHash }),
      }),
    onSuccess: async (result) => {
      toast(result.status === 'APPLIED' ? 'Approved action saved' : 'Proposal rejected');
      await Promise.all([invalidate(), refresh()]);
    },
    onError: async (error) => {
      toast(error.message, true);
      await invalidate();
    },
  });
  const running = detail.data?.runs.some(
    (r) => r.status === 'RUNNING' && +new Date(r.createdAt) > now - RUN_TTL_MS,
  );
  const busy = send.isPending || !!running;
  const retryAt = Math.max(
    0,
    providerFailure(send.error?.message)?.retryAt ?? 0,
    ...(detail.data?.runs.map((r) => providerFailure(r.error)?.retryAt ?? 0) ?? []),
  );
  const coolingDown = retryAt > now;
  const failureInHistory =
    detail.data?.runs.at(-1)?.status === 'FAILED' &&
    (detail.data.runs.at(-1)?.requestId
      ? detail.data.runs.at(-1)?.requestId === send.variables?.key
      : detail.data.runs.at(-1)?.prompt === send.variables?.text);
  const scopeReady = !id || !!detail.data;
  const actualProjectId = id ? detail.data?.projectId : project === 'all' ? null : project;
  const localProjects = data.projects.filter(
    (p) => !p.archivedAt && (!actualProjectId || p.id === actualProjectId),
  );
  const localPrompts = detail.data?.runs.map((r) => r.prompt) ?? [];
  const localContext = {
    projects: localProjects,
    projectTotal: localProjects.length,
    projectId: actualProjectId ?? null,
  };
  const providerBlocked =
    coolingDown &&
    planTaskRead(
      prompt,
      { ...localContext, establishedProjectId: establishedProject(localPrompts, localContext) },
      localPrompts.at(-1),
    )?.kind !== 'read';
  const currentProject =
    (id ? detail.data?.project : null) ?? data.projects.find((p) => p.id === actualProjectId);
  const archived = !!currentProject?.archivedAt;
  const scopeLabel =
    scopeReady && actualProjectId && currentProject
      ? `Project: ${currentProject.name}${archived ? ' (archived)' : ''}`
      : conversationScopeLabel(data, actualProjectId, !scopeReady);
  const choosePrompt = (value: string) => {
    if (busy) return;
    setPrompt(value);
    requestId.current = null;
    document.getElementById('agent-prompt')?.focus();
  };
  const newConversation = () => {
    setProject(!archived ? initialAssistantProject(data, actualProjectId ?? undefined) : 'all');
    setId('');
    setPanel('chat');
    setHistoryOpen(false);
    setContextOpen(true);
    setPrompt('');
    requestId.current = null;
    send.reset();
  };
  const chatContext: ChatContext = {
    data,
    projectId: id ? (detail.data?.projectId ?? null) : project === 'all' ? null : project,
    openTask: id && !detail.data ? undefined : openTask,
  };
  const revision =
    JSON.stringify(
      detail.data?.runs.map((r) => [
        r.id,
        r.status,
        r.answer,
        r.events.length,
        r.proposals.map((p) => p.status),
      ]),
    ) + send.isPending;
  const {
    ref: transcriptRef,
    onScroll: onTranscriptScroll,
    showLatest,
    latest,
  } = useChatScroll(id, revision);
  const submit = () => {
    if (
      submitting.current ||
      busy ||
      providerBlocked ||
      !scopeReady ||
      archived ||
      !prompt.trim() ||
      !config.data?.configured
    )
      return;
    submitting.current = true;
    requestId.current ??= crypto.randomUUID();
    latest();
    send.mutate({ text: prompt.trim(), key: requestId.current });
  };
  const history = (
    <>
      <div className="panel-heading">
        <div>
          <h2>
            <History size={15} /> Your conversations
          </h2>
          <p>Private to you in this workspace.</p>
        </div>
      </div>
      <Button variant="outline" size="sm" disabled={busy} onClick={newConversation}>
        <Plus size={14} /> New conversation
      </Button>
      {conversations.isPending && <p className="quiet-state">Loading conversations…</p>}
      {conversations.isError && (
        <p role="alert" className="form-error">
          {conversations.error.message}{' '}
          <button type="button" onClick={() => void conversations.refetch()}>
            Retry history
          </button>
        </p>
      )}
      <nav aria-label="AI conversations">
        {conversations.data?.map((c) => (
          <button
            disabled={busy}
            title={c.title}
            aria-label={`${c.title} · ${conversationScopeLabel(data, c.projectId)}`}
            aria-current={id === c.id ? 'page' : undefined}
            className={cn('agent-history-item', id === c.id && 'selected')}
            key={c.id}
            onClick={() => {
              setId(c.id);
              setPanel('chat');
              setHistoryOpen(false);
              setContextOpen(false);
              setPrompt('');
              requestId.current = null;
            }}
          >
            <MessageSquare size={13} />
            <span>
              <span className="agent-history-title">{c.title}</span>
              <small>{conversationScopeLabel(data, c.projectId)}</small>
            </span>
          </button>
        ))}
      </nav>
      {conversations.data?.length === 0 && (
        <p className="quiet-state">Start a conversation to keep your project decisions together.</p>
      )}
      <details className="agent-privacy">
        <summary>
          <ShieldCheck size={14} /> Privacy & approvals
        </summary>
        <p>
          Sending a request shares authorized project records with your server-configured AI
          provider. Approved tasks, sprints and reports are visible to the workspace.
        </p>
      </details>
    </>
  );
  return (
    <div className="agent-layout">
      <aside className="agent-history">{history}</aside>
      <Dialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        title="Your conversations"
        description="Private history in this workspace"
      >
        <div className="agent-history-drawer">{history}</div>
      </Dialog>
      <section className="agent-chat" aria-label="AI project manager">
        <header className="agent-chat-header">
          <button
            type="button"
            className="agent-history-toggle"
            aria-label="Open conversations"
            onClick={() => setHistoryOpen(true)}
          >
            <History size={17} />
          </button>
          <div className="agent-chat-heading">
            <h2 title={detail.data?.title}>{detail.data?.title ?? 'New conversation'}</h2>
            <details
              className="agent-context"
              aria-label="Conversation context"
              open={contextOpen}
              onToggle={(e) => setContextOpen(e.currentTarget.open)}
            >
              <summary>
                {scopeLabel} <span aria-hidden="true"> · </span>
                <span title={config.data?.model}>
                  {config.isPending
                    ? 'Checking model…'
                    : modelLabel(config.data?.configured ? config.data.model : undefined)}
                </span>
              </summary>
              <div className="agent-context-options">
                <p>{data.workspace.name}</p>
                {id ? (
                  <p className="agent-scope-note">
                    Conversation scope stays fixed.{' '}
                    <button type="button" disabled={busy || !scopeReady} onClick={newConversation}>
                      Start a new scope
                    </button>
                  </p>
                ) : (
                  <label className="agent-scope-select">
                    Conversation scope
                    <select
                      aria-label="AI project context"
                      disabled={busy}
                      value={project}
                      onChange={(e) => setProject(e.target.value)}
                    >
                      <option value="all">All accessible projects in this workspace</option>
                      {data.projects
                        .filter((p) => !p.archivedAt)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <details className="agent-scope-help">
                  <summary>About task views</summary>
                  <p>
                    Assigned to me means your assignee ID, not tasks you created. Unassigned work
                    belongs to the project and may still need attention. Creator history is not
                    recorded, so “Created by me” is unavailable. Task reads exclude archived
                    projects; completed tasks appear unless you request pending work.
                  </p>
                </details>
              </div>
            </details>
          </div>
          <div className="agent-panel-tabs" aria-label="Conversation panels">
            <button type="button" aria-pressed={panel === 'chat'} onClick={() => setPanel('chat')}>
              Chat
            </button>
            <button
              type="button"
              aria-pressed={panel === 'plans'}
              onClick={() => setPanel('plans')}
            >
              Plans & reports
            </button>
          </div>
        </header>
        <div
          ref={transcriptRef}
          onScroll={onTranscriptScroll}
          className="agent-transcript"
          hidden={panel !== 'chat'}
          aria-label="Conversation messages"
          aria-busy={busy}
        >
          {archived && (
            <p className="configuration-message" role="status">
              This project is archived. History remains available; start a new scope to work with
              active projects.
            </p>
          )}
          {!config.data?.configured && !config.isPending && (
            <div className="configuration-message" role="status">
              <h3>Connect an AI provider</h3>
              <p>{config.isError ? config.error.message : config.data?.reason}</p>
              <code>AI_API_KEY · AI_BASE_URL · AI_MODEL</code>
              <p>
                History and previously approved plans remain available. No sample AI responses are
                generated.
              </p>
            </div>
          )}
          {id && detail.isPending && (
            <p role="status" className="quiet-state">
              Loading conversation…
            </p>
          )}
          {detail.isError && (
            <p className="form-error" role="alert">
              {detail.error.message}{' '}
              <button type="button" onClick={() => void detail.refetch()}>
                Retry conversation
              </button>
            </p>
          )}
          {(!id || (detail.data?.runs.length === 0 && !busy)) && (
            <div className="agent-welcome">
              <Sparkles size={28} />
              <h3>From a question to a clear next step.</h3>
              <p>
                Inspect progress, find blockers, write task briefs, break down work, plan sprints or
                prepare a weekly report.
              </p>
              <div className="agent-prompts">
                {prompts.map(([label, text]) => (
                  <button
                    key={label}
                    onClick={() => {
                      setPrompt(text);
                      requestId.current = null;
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {detail.data?.runs.map((run) => (
            <article className="agent-turn" key={run.id}>
              <AIMessage role="user" content={run.prompt} />
              <AIMessage
                role="assistant"
                content={run.status === 'COMPLETED' ? run.answer : undefined}
                context={chatContext}
              >
                {run.status === 'FAILED' ? (
                  <div className="agent-failure" role="alert">
                    <p>{providerErrorMessage(run.error)}</p>
                    {run.events.some(
                      (e) =>
                        e.name !== 'createTask' &&
                        e.name !== 'updateTask' &&
                        e.name !== 'createSprint' &&
                        e.name !== 'generateReport' &&
                        e.output &&
                        typeof e.output === 'object' &&
                        !('error' in e.output),
                    ) && (
                      <p>
                        The workspace data below was retrieved successfully. The assistant did not
                        complete its response.
                      </p>
                    )}
                  </div>
                ) : run.status === 'RUNNING' ? (
                  <p>
                    <Clock3 size={13} />{' '}
                    {+new Date(run.createdAt) > now - RUN_TTL_MS
                      ? 'Reviewing workspace records…'
                      : 'This request was interrupted. Send a new request to continue.'}
                  </p>
                ) : null}
                {run.status === 'FAILED' && (
                  <VerifiedResults events={run.events} context={chatContext} />
                )}
                {run.proposals.map((proposal) => (
                  <Proposal
                    key={proposal.id}
                    proposal={proposal}
                    data={data}
                    now={now}
                    disabled={decide.isPending}
                    approve={() => decide.mutate({ proposal, decision: 'approve' })}
                    reject={() => decide.mutate({ proposal, decision: 'reject' })}
                    openTask={openTask}
                  />
                ))}
                {!!run.events.length && (
                  <div className="chat-tool-group" aria-label="Workspace activity">
                    {run.events.map((event) => (
                      <ToolActivity
                        key={event.id}
                        event={event}
                        context={chatContext}
                        runFailed={run.status === 'FAILED'}
                      />
                    ))}
                  </div>
                )}
              </AIMessage>
            </article>
          ))}
          {send.isPending && (
            <p className="agent-thinking">
              <Loader2 size={15} className="spin" /> Thinking through your request. Proposals will
              need your approval.
            </p>
          )}
        </div>
        {showLatest && panel === 'chat' && (
          <button type="button" className="chat-jump-latest" onClick={latest}>
            Jump to latest message ↓
          </button>
        )}
        <form
          className="agent-composer"
          hidden={panel !== 'chat'}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="agent-task-views" role="group" aria-label="Task views">
            {taskViewPrompts.map(([label, text]) => (
              <button
                type="button"
                key={label}
                disabled={busy || !scopeReady || archived}
                onClick={() => choosePrompt(text)}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              disabled={busy || !scopeReady || archived}
              onClick={() =>
                choosePrompt(actualProjectId ? projectTaskPrompt : workspaceTaskPrompt)
              }
            >
              {actualProjectId ? 'All project tasks' : 'All workspace tasks'}
            </button>
          </div>
          <label className="sr-only" htmlFor="agent-prompt">
            Message your project manager
          </label>
          <div className="agent-composer-input">
            <textarea
              ref={composerRef}
              id="agent-prompt"
              placeholder="Ask about a project, plan work or propose a change…"
              rows={1}
              maxLength={4000}
              value={prompt}
              disabled={busy || !scopeReady || archived}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              onChange={(e) => {
                setPrompt(e.target.value);
                requestId.current = null;
              }}
            />
            <Button
              type="submit"
              aria-label={busy ? 'Working…' : 'Send request'}
              disabled={
                busy ||
                providerBlocked ||
                !scopeReady ||
                archived ||
                !config.data?.configured ||
                !prompt.trim()
              }
            >
              <Send size={15} />
              <span className="agent-send-label">{busy ? 'Working…' : 'Send request'}</span>
            </Button>
          </div>
          <small className="agent-composer-note">
            Changes require approval · Ctrl / ⌘ + Enter to send
            {providerBlocked ? ` · Retry after ${new Date(retryAt).toLocaleTimeString()}` : ''}
          </small>
          {send.isError && !failureInHistory && (
            <div className="form-error" role="alert">
              {providerErrorMessage(send.error.message)}{' '}
              <button
                type="button"
                onClick={submit}
                disabled={busy || providerBlocked || !prompt.trim() || !config.data?.configured}
              >
                Retry request
              </button>
            </div>
          )}
        </form>
        <section
          className="agent-artifacts"
          aria-label="Approved project plans"
          hidden={panel !== 'plans'}
        >
          <h3>Approved plans & reports</h3>
          <p className="agent-footnote">Latest 20 of each · {scopeLabel}</p>
          {artifacts.isError && (
            <p className="form-error" role="alert">
              {artifacts.error.message}{' '}
              <button type="button" disabled={!scopeReady} onClick={() => void artifacts.refetch()}>
                Retry plans & reports
              </button>
            </p>
          )}
          {!artifacts.isPending &&
            artifacts.data &&
            !artifacts.data.sprints.length &&
            !artifacts.data.reports.length && (
              <p className="quiet-state">
                Approved sprint plans and reports will appear here. No plans have been saved yet.
              </p>
            )}
          {artifacts.data?.sprints.map((s) => (
            <details className="panel agent-artifact" key={s.id}>
              <summary>
                <Target size={16} />
                <strong>{s.name}</strong>
                <span>
                  {s.project.name} · {s.tasks.length} tasks
                </span>
              </summary>
              <p>{s.goal}</p>
              <small>
                {date(s.startDate)} – {date(s.endDate)} UTC
              </small>
              <ul>
                {s.tasks.map((t) => (
                  <li key={t.taskId}>
                    {t.titleSnapshot}{' '}
                    <span>
                      · {chatStatusLabels[t.statusSnapshot] ?? t.statusSnapshot} when planned
                    </span>
                  </li>
                ))}
              </ul>
              <p className="agent-footnote">
                Task names/statuses above are the approved planning baseline.
              </p>
            </details>
          ))}
          {artifacts.data?.reports.map((r) => (
            <details className="panel agent-artifact" key={r.id}>
              <summary>
                <FileText size={16} />
                <strong>{r.title}</strong>
                <span>{r.project.name}</span>
              </summary>
              <small>
                {date(r.periodStart)} – {date(r.periodEnd)} UTC
              </small>
              <ChatMarkdown content={r.content} context={chatContext} />
              <details>
                <summary>Recorded source metrics</summary>
                <pre>{JSON.stringify(r.source, null, 2)}</pre>
              </details>
            </details>
          ))}
        </section>
      </section>
    </div>
  );
}

function Proposal({
  proposal,
  data,
  disabled,
  approve,
  reject,
  openTask,
  now,
}: {
  proposal: ProposalView;
  data: Snapshot;
  disabled: boolean;
  approve: () => void;
  reject: () => void;
  openTask?: (id: string) => void;
  now: number;
}) {
  const p = proposal.preview;
  const project = p.project as { name: string };
  const target = p.task as { number: number; title: string } | undefined;
  const before = p.before as Record<string, unknown> | undefined;
  const changes = p.changes as Record<string, unknown> | undefined;
  const tasks = p.tasks as { id: string; number: number; title: string }[] | undefined;
  const expired = +new Date(proposal.expiresAt) <= now;
  const pending = proposal.status === 'PENDING' && !expired;
  const label =
    {
      createTask: 'Create task',
      updateTask: 'Update task',
      createSprint: 'Save sprint plan',
      generateReport: 'Save project report',
    }[proposal.tool] ?? proposal.tool;
  const display = (key: string, value: unknown) =>
    friendlyField(key, value, { data, projectId: null });
  const names: Record<string, string> = {
    title: 'Title',
    description: 'Description',
    status: 'Status',
    priority: 'Priority',
    assigneeId: 'Assignee',
    labelIds: 'Labels',
    startDate: 'Start date (UTC)',
    dueDate: 'Due date (UTC)',
    isMilestone: 'Milestone',
  };
  return (
    <section className="agent-proposal" aria-label={`${label} preview`}>
      <header>
        <ShieldCheck size={15} />
        <strong>{label}</strong>
        <span>
          {proposal.status === 'PENDING' && expired ? 'Expired' : proposal.status.toLowerCase()}
        </span>
      </header>
      <p className="agent-proposal-project">
        {project.name}
        {target ? ` · DEV-${target.number} ${target.title}` : ''}
      </p>
      {changes && before ? (
        <dl className="agent-change-list">
          {Object.entries(changes).map(([key, value]) => (
            <div key={key}>
              <dt>{names[key] ?? key}</dt>
              <dd>
                <span className="agent-before">{display(key, before[key])}</span>
                <span aria-hidden="true"> → </span>
                <strong>{display(key, value)}</strong>
              </dd>
            </div>
          ))}
        </dl>
      ) : proposal.tool === 'createTask' ? (
        <>
          <h3>{String(p.title)}</h3>
          <ChatMarkdown content={String(p.description || 'No description')} />
          {p.description ? (
            <details>
              <summary>Exact description text</summary>
              <pre>{String(p.description)}</pre>
            </details>
          ) : null}
          <dl className="agent-change-list">
            {[
              'status',
              'priority',
              'assigneeId',
              'startDate',
              'dueDate',
              'isMilestone',
              'labelIds',
            ].map((key) => (
              <div key={key}>
                <dt>{names[key]}</dt>
                <dd>{display(key, p[key])}</dd>
              </div>
            ))}
          </dl>
          {p.parent ? (
            <p>
              Subtask of DEV-{String((p.parent as { number: number }).number)} ·{' '}
              {String((p.parent as { title: string }).title)}
            </p>
          ) : null}
        </>
      ) : proposal.tool === 'createSprint' ? (
        <>
          <h3>{String(p.name)}</h3>
          <p>{String(p.goal)}</p>
          <small>
            {date(p.startDate)} – {date(p.endDate)} UTC
          </small>
          <ul>
            {tasks?.map((t) => (
              <li key={t.id}>
                DEV-{t.number} · {t.title}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <h3>{String(p.title)}</h3>
          <small>
            {date(p.periodStart)} – {date(p.periodEnd)} UTC
          </small>
          <ChatMarkdown content={String(p.content)} />
          <details>
            <summary>Exact report text</summary>
            <pre>{String(p.content)}</pre>
          </details>
          <details>
            <summary>Source snapshot used for this report</summary>
            <pre>{JSON.stringify(p.source, null, 2)}</pre>
          </details>
        </>
      )}
      <details className="agent-preview-values">
        <summary>Exact preview values</summary>
        <pre>{JSON.stringify(proposal.preview, null, 2)}</pre>
      </details>
      {pending && (
        <footer>
          <small>
            Review the complete preview. Expires at{' '}
            {new Date(proposal.expiresAt).toLocaleTimeString()}.
          </small>
          <div>
            <Button size="sm" variant="outline" disabled={disabled} onClick={reject}>
              <X size={12} />
              Reject
            </Button>
            <Button size="sm" disabled={disabled} onClick={approve}>
              <Check size={12} />
              Approve: {label.toLowerCase()}
            </Button>
          </div>
        </footer>
      )}
      {proposal.status === 'APPLIED' && proposal.result && (
        <p className="agent-receipt">
          <Check size={13} />
          Saved
          {proposal.result.type === 'task' && openTask ? (
            <button onClick={() => openTask(String(proposal.result!.id))}>Open task</button>
          ) : null}
        </p>
      )}
    </section>
  );
}
