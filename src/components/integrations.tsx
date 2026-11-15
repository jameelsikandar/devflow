'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitFork as GithubIcon,
  GitPullRequest,
  KeyRound,
  Loader2,
  LogOut,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Star,
  Unplug,
  Upload,
} from 'lucide-react';
import { api, body, useToasts } from '@/lib/client';
import type { GitHubData, Person, Snapshot } from '@/lib/types';
import { cn, relativeDate } from '@/lib/utils';
import { Avatar, Empty } from './common';
import { Button } from './ui/button';
import { GitHubProcessing } from './github-processing';
import { AgentManager } from './agent-manager';
import './assistant-page.css';
import { initialAssistantProject, conversationScopeLabel, modelLabel } from '@/lib/agent-view';
import { ChatMarkdown } from './chat/markdown';
import { CopyButton } from './chat/copy-button';
import { Dialog } from './ui/dialog';
type Scope = (route: string) => string;
const aiActions = [
  {
    id: 'subtasks',
    title: 'Find the smaller steps',
    description: 'Break a big task into a clear action plan.',
    icon: GitBranch,
  },
  {
    id: 'description',
    title: 'Start with a better brief',
    description: 'Turn a rough idea into a useful task.',
    icon: Copy,
  },
  {
    id: 'sprint',
    title: 'Plan your next sprint',
    description: 'Make a realistic plan from current work.',
    icon: Sparkles,
  },
  {
    id: 'summary',
    title: 'Catch up, in a moment',
    description: 'Get the bigger picture of your project.',
    icon: GitCommitHorizontal,
  },
  {
    id: 'priorities',
    title: 'Make the next move count',
    description: 'Find what deserves your attention first.',
    icon: Star,
  },
  {
    id: 'risks',
    title: 'See around the corner',
    description: 'Spot overdue work and delivery risks.',
    icon: AlertCircle,
  },
] as const;
export function Assistant({
  data,
  scope,
  refresh,
  openTask,
  selectedProjectId,
}: {
  data: Snapshot;
  scope: Scope;
  refresh: () => Promise<void>;
  openTask?: (id: string) => void;
  selectedProjectId?: string;
}) {
  const [mode, setMode] = useState<'manager' | 'drafts'>('manager');
  return (
    <section className="assistant-page" aria-label="AI assistant">
      <div className="assistant-toolbar">
        <h1>AI assistant</h1>
        <div className="segmented assistant-mode-tabs" aria-label="Assistant mode">
          <button
            aria-pressed={mode === 'manager'}
            className={mode === 'manager' ? 'selected' : ''}
            onClick={() => setMode('manager')}
          >
            Project manager
          </button>
          <button
            aria-pressed={mode === 'drafts'}
            className={mode === 'drafts' ? 'selected' : ''}
            onClick={() => setMode('drafts')}
          >
            Quick drafts
          </button>
        </div>
      </div>
      <div className="assistant-manager-frame" hidden={mode !== 'manager'}>
        <AgentManager
          key={data.workspace.id}
          data={data}
          scope={scope}
          refresh={refresh}
          openTask={openTask}
          selectedProjectId={selectedProjectId}
        />
      </div>
      {mode === 'drafts' && (
        <QuickDraftAssistant
          key={data.workspace.id}
          data={data}
          scope={scope}
          selectedProjectId={selectedProjectId}
          openTask={openTask}
        />
      )}
    </section>
  );
}
function QuickDraftAssistant({
  data,
  scope,
  selectedProjectId,
  openTask,
}: {
  data: Snapshot;
  scope: Scope;
  selectedProjectId?: string;
  openTask?: (id: string) => void;
}) {
  const [action, setAction] = useState<string>('subtasks');
  const [project, setProject] = useState(() => initialAssistantProject(data, selectedProjectId));
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState('');
  const configuration = useQuery({
    queryKey: ['agent', data.workspace.id, 'config'],
    queryFn: () => api<{ configured: boolean; model: string }>(scope('ai/config')),
  });
  const generate = useMutation({
    mutationFn: () =>
      api<{ text: string }>(scope('ai'), {
        method: 'POST',
        body: body({ action, prompt, ...(project === 'all' ? {} : { projectId: project }) }),
      }),
    onSuccess: (data) => setResult(data.text),
  });
  return (
    <div className="assistant-layout">
      <section>
        <div
          className="agent-context-trail assistant-draft-context"
          aria-label="Quick Draft context"
        >
          <span>{data.workspace.name}</span>
          <span aria-hidden="true"> / </span>
          <strong>{conversationScopeLabel(data, project === 'all' ? null : project)}</strong>
          <span aria-hidden="true"> / </span>
          <span title={configuration.data?.model}>
            Model:{' '}
            {configuration.isPending
              ? 'Checking configuration…'
              : modelLabel(configuration.data?.configured ? configuration.data.model : undefined)}
          </span>
        </div>
        <div className="assistant-intro">
          <span className="assistant-symbol">
            <Sparkles size={24} />
          </span>
          <h2>
            A thinking partner.
            <br />
            <span>For your next great move.</span>
          </h2>
          <p>
            Grounded in your actual project records.
            <br />A starting point for your judgment.
          </p>
        </div>
        <div className="ai-action-grid">
          {aiActions.map((a) => (
            <button
              key={a.id}
              onClick={() => setAction(a.id)}
              className={cn('ai-action', action === a.id && 'selected')}
              aria-pressed={action === a.id}
            >
              <a.icon size={18} />
              <h3>{a.title}</h3>
              <p>{a.description}</p>
              {action === a.id && <Check size={13} className="ai-action-check" />}
            </button>
          ))}
        </div>
        <div className="integration-note">
          <ShieldCheck size={16} />
          <p>
            Requests include project task data and go to your configured provider. API keys stay on
            the server. Suggestions never change tasks automatically.
          </p>
        </div>
      </section>
      <section className="panel assistant-composer">
        <div className="panel-heading">
          <div>
            <h2>{aiActions.find((a) => a.id === action)?.title}</h2>
            <p>A little context makes all the difference.</p>
          </div>
          <Sparkles size={18} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setResult('');
            generate.mutate();
          }}
        >
          <label>
            Project context
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="all">All active projects</option>
              {data.projects
                .filter((p) => !p.archivedAt)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            What’s on your mind?
            <textarea
              rows={6}
              maxLength={4000}
              placeholder="e.g. We’re building a notification center. Help me break down the frontend and API work..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <Button type="submit" disabled={generate.isPending}>
            {generate.isPending ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}{' '}
            {generate.isPending ? 'Thinking it through...' : 'Give me a starting point'}
          </Button>
        </form>
        {generate.isError && (
          <div className="configuration-message" role="alert">
            <KeyRound size={20} />
            <h3>Let’s connect your thinking partner.</h3>
            <p>{generate.error.message}</p>
            <code>AI_API_KEY · AI_BASE_URL · AI_MODEL</code>
          </div>
        )}
        {result && (
          <div className="ai-result">
            <div>
              <span>
                <Sparkles size={14} /> AI suggestion
              </span>
              <CopyButton text={result} label="Copy draft" />
            </div>
            <ChatMarkdown
              content={result}
              context={{ data, projectId: project === 'all' ? null : project, openTask }}
            />
          </div>
        )}
        {!result && !generate.isError && !generate.isPending && (
          <div className="assistant-ready">
            <span>✧</span>
            <p>
              Your next good idea
              <br />
              could start right here.
            </p>
            <small>Requires a server-configured AI provider.</small>
          </div>
        )}
      </section>
    </div>
  );
}
export function GitHub({
  data,
  scope,
  refresh,
  openTask,
}: {
  data: Snapshot;
  scope: Scope;
  refresh: () => Promise<void>;
  openTask?: (id: string) => void;
}) {
  const [project, setProject] = useState(data.projects.find((p) => !p.archivedAt)?.id ?? '');
  const toast = useToasts((s) => s.add);
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const github = useQuery({
    queryKey: ['github', data.workspace.id, project],
    queryFn: () => api<GitHubData>(`${scope('github')}${project ? `&projectId=${project}` : ''}`),
  });
  const info = github.data;
  const current = data.projects.find((p) => p.id === project);
  const [setup, setSetup] = useState<{ url: string; secret: string; events: string[] } | null>(
    null,
  );
  const connections = useQuery({
    queryKey: ['github-repositories', data.workspace.id, project],
    enabled: !!project,
    queryFn: () =>
      api<{ id: string; repositoryFullName: string }[]>(
        `${scope('github/repositories')}&projectId=${encodeURIComponent(project)}`,
      ),
  });
  const active = connections.data?.[0];
  const canManage = data.workspace.role !== 'MEMBER';
  async function link(repository: string | null) {
    if (!project) return;
    setPending(true);
    try {
      if (repository) {
        const result = await api<{ setup: { url: string; secret: string; events: string[] } }>(
          scope('github/repositories'),
          { method: 'POST', body: body({ projectId: project, repository }) },
        );
        setSetup(result.setup);
      } else if (active) {
        await api(scope(`github/repositories/${active.id}`), { method: 'DELETE' });
      } else {
        await api(scope(`projects/${project}`), {
          method: 'PATCH',
          body: body({ repository: null }),
        });
      }
      await connections.refetch();
      await refresh();
      await github.refetch();
      toast(repository ? 'Repository linked' : 'Repository unlinked');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <section className="github-banner">
        <div className="github-big-icon">
          <GithubIcon size={35} />
        </div>
        <div>
          <span className="eyebrow">CODE MEETS CONTEXT</span>
          <h2>
            Less tab switching.
            <br />
            More shipping.
          </h2>
          <p>Connect your repositories to the work behind them.</p>
        </div>
        <div>
          {info?.connected ? (
            <div className="connected-account">
              <span className="live-dot" />
              Connected as <strong>{info.login}</strong>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await api(scope('github'), { method: 'DELETE' });
                    await client.invalidateQueries({ queryKey: ['github'] });
                    toast('GitHub disconnected');
                  } catch (e) {
                    toast((e as Error).message, true);
                  }
                }}
              >
                <Unplug size={13} />
                Disconnect
              </Button>
            </div>
          ) : info?.configured ? (
            <Button onClick={() => window.location.assign('/api/github/connect')}>
              <GithubIcon size={16} />
              Connect GitHub
              <ArrowUpRight size={15} />
            </Button>
          ) : (
            <span className="setup-badge">
              <KeyRound size={14} />
              Setup required
            </span>
          )}
        </div>
      </section>
      {github.isLoading && <p className="quiet-state">Loading GitHub connection...</p>}
      {github.isError && (
        <div className="notice form-error" role="alert">
          {github.error.message}
          <Button variant="outline" size="sm" onClick={() => void github.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {info && !info.configured && !info.connected && (
        <div className="configuration-message github-config">
          <KeyRound size={20} />
          <div>
            <h3>Connect on your terms.</h3>
            <p>
              Create a GitHub OAuth app, set the callback to{' '}
              <code>
                {typeof window !== 'undefined' ? window.location.origin : ''}/api/github/callback
              </code>
              , then add <code>GITHUB_CLIENT_ID</code>, <code>GITHUB_CLIENT_SECRET</code>, and a
              64-character hex <code>TOKEN_ENCRYPTION_KEY</code> to your server environment.
            </p>
            <small>
              OAuth tokens are encrypted at rest and never sent to your browser. See README for the
              complete setup.
            </small>
          </div>
        </div>
      )}
      <Dialog
        open={!!setup}
        onOpenChange={(open) => {
          if (!open) setSetup(null);
        }}
        title="Configure the repository webhook"
        description="This secret is shown once. Save it in GitHub before closing this dialog."
      >
        {setup && (
          <div className="dialog-form">
            <p>
              In GitHub repository Settings → Webhooks, add a webhook with these values. Keep SSL
              verification enabled.
            </p>
            <label>
              Payload URL
              <input readOnly value={setup.url} />
            </label>
            <label>
              Webhook secret
              <input readOnly value={setup.secret} autoComplete="off" spellCheck={false} />
            </label>
            <CopyButton text={setup.secret} label="Copy webhook secret" />
            <p>
              Content type: application/json. Select: {setup.events.join(', ')}. OAuth did not
              create this hook.
            </p>
            <p>
              If the secret is lost, disconnect this connection and reconnect to generate a new one.
            </p>
          </div>
        )}
      </Dialog>
      {project && (
        <section className="panel configuration-message">
          <h3>Repository webhook · {current?.name}</h3>
          {connections.isPending ? (
            <p role="status">Loading repository connection…</p>
          ) : connections.isError ? (
            <p role="alert">{connections.error.message}</p>
          ) : active ? (
            <>
              <p>
                {active.repositoryFullName} · Connection ready for manual GitHub webhook setup.
                Accepted events are queued for the separate worker; task automation is disabled.
              </p>
              <p>
                Webhook secrets are separate from OAuth. Disconnecting the account only removes its
                OAuth token.
              </p>
              <Button
                variant="outline"
                disabled={!canManage || pending}
                onClick={() => void link(null)}
              >
                Disconnect repository webhook
              </Button>
            </>
          ) : (
            <>
              <p>
                Connect a repository below to create a secure webhook inbox. Requires workspace
                administrator and GitHub repository administrator access.
              </p>
              {current?.repository && (
                <p>
                  Existing activity link: {current.repository}. This alone does not authorize
                  webhooks.{' '}
                  <button
                    type="button"
                    disabled={!canManage || pending}
                    onClick={() => void link(null)}
                  >
                    Unlink legacy activity
                  </button>
                </p>
              )}
            </>
          )}
          <p>
            Remove the webhook in GitHub after disconnecting. Previously accepted receipts remain
            stored; pending work is cancelled.
          </p>
        </section>
      )}
      {project && (
        <GitHubProcessing
          key={`${data.workspace.id}:${project}:${active?.id ?? ''}`}
          workspaceId={data.workspace.id}
          projectId={project}
          connectionId={active?.id}
          admin={canManage}
          scope={scope}
          openTask={
            openTask
              ? (id) => {
                  if (data.tasks?.some((t) => t.id === id && t.projectId === project)) openTask(id);
                }
              : undefined
          }
        />
      )}
      {info?.demo && (
        <p className="demo-banner">
          <AlertCircle size={15} /> Sample data · Local demo mode. These are illustrative records,
          not your GitHub activity.
        </p>
      )}
      {info?.repositories.length ? (
        <>
          <div className="section-heading">
            <h2>
              Your repositories <span className="number-badge">{info.repositories.length}</span>
            </h2>
            <label className="inline-label">
              Link to project
              <select
                aria-label="Project to link repository"
                disabled={pending}
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                <option value="">Choose a project</option>
                {data.projects
                  .filter((p) => !p.archivedAt)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="repo-grid">
            {info.repositories.map((repo) => (
              <article className="panel repo-card" key={repo.id}>
                <div>
                  <GitBranch size={18} />
                  <a href={repo.html_url} target="_blank" rel="noreferrer">
                    {repo.full_name}
                    <ExternalLink size={13} />
                  </a>
                  <span className="tag">{repo.private ? 'Private' : 'Public'}</span>
                </div>
                <p>{repo.description ?? 'A repository of possibilities.'}</p>
                <footer>
                  <span>
                    <i className="project-dot" style={{ background: '#8eadeb' }} />
                    {repo.language ?? 'Code'}
                  </span>
                  <span>
                    <Star size={13} />
                    {repo.stargazers_count}
                  </span>
                  {info.connected && (
                    <Button
                      size="sm"
                      disabled={
                        !project ||
                        pending ||
                        !canManage ||
                        connections.isPending ||
                        connections.isError ||
                        (!!active && active.repositoryFullName !== repo.full_name)
                      }
                      variant={active?.repositoryFullName === repo.full_name ? 'outline' : 'ghost'}
                      onClick={() =>
                        void link(
                          active?.repositoryFullName === repo.full_name ? null : repo.full_name,
                        )
                      }
                    >
                      {active?.repositoryFullName === repo.full_name ? (
                        <Check size={13} />
                      ) : (
                        <Plus size={13} />
                      )}{' '}
                      {active?.repositoryFullName === repo.full_name
                        ? 'Connected · disconnect'
                        : 'Connect project'}
                    </Button>
                  )}
                </footer>
              </article>
            ))}
          </div>
        </>
      ) : (
        info &&
        !info.connected &&
        !info.demo && (
          <Empty
            title="Your code belongs in the picture"
            description="Once GitHub is connected, your repositories, commits, and open pull requests will appear here."
          />
        )
      )}
      {info?.connected && current?.repository && (
        <div className="github-activity-grid">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Recent commits</h2>
                <p>{current.repository}</p>
              </div>
              <GitCommitHorizontal size={18} />
            </div>
            {info.commits?.length ? (
              info.commits.map((c) => (
                <a
                  key={c.sha}
                  className="commit-row"
                  href={c.html_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <GitCommitHorizontal size={16} />
                  <span>
                    <strong>{c.commit.message.split('\n')[0]}</strong>
                    <small>
                      {c.commit.author.name} · {relativeDate(c.commit.author.date)}
                    </small>
                  </span>
                  <code>{c.sha.slice(0, 7)}</code>
                </a>
              ))
            ) : (
              <p className="quiet-state">No commits to show.</p>
            )}
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Open pull requests</h2>
                <p>Good work, under review.</p>
              </div>
              <GitPullRequest size={18} />
            </div>
            {info.pulls?.length ? (
              info.pulls.map((pr) => (
                <a
                  className="commit-row"
                  key={pr.id}
                  href={pr.html_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <GitPullRequest size={16} />
                  <span>
                    <strong>{pr.title}</strong>
                    <small>
                      #{pr.number} · {pr.user.login}
                    </small>
                  </span>
                  <ArrowUpRight size={14} />
                </a>
              ))
            ) : (
              <p className="quiet-state">No open pull requests. A clear runway.</p>
            )}
          </section>
        </div>
      )}
    </>
  );
}
export function Settings({
  user,
  data,
  online,
  invite,
  scope,
  refresh,
}: {
  user: Person;
  data: Snapshot;
  online: string[];
  invite: () => void;
  scope: Scope;
  refresh: () => Promise<void>;
}) {
  const [name, setName] = useState(user.name);
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrent] = useState('');
  const [pending, setPending] = useState(false);
  const [labelName, setLabelName] = useState('');
  const [color, setColor] = useState('#a78bfa');
  const toast = useToasts((s) => s.add);
  return (
    <div className="settings-layout">
      <section className="panel settings-panel">
        <div className="panel-heading">
          <div>
            <h2>Your profile</h2>
            <p>The person behind the good work.</p>
          </div>
          <Settings2 size={18} />
        </div>
        <div className="profile-avatar-setting">
          <Avatar person={user} size="large" />
          <div>
            <label className="button button-outline button-sm upload-label">
              <Upload size={14} />
              Upload avatar
              <input
                className="sr-only"
                type="file"
                accept="image/png,image/jpeg"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 524288) {
                    toast('Choose an image smaller than 512 KB', true);
                    return;
                  }
                  try {
                    await api('avatar', {
                      method: 'POST',
                      body: file,
                      headers: { 'Content-Type': file.type },
                    });
                    await refresh();
                    toast('Avatar updated');
                  } catch (error) {
                    toast((error as Error).message, true);
                  }
                  e.target.value = '';
                }}
              />
            </label>
            <small>PNG or JPEG. Up to 512 KB.</small>
          </div>
        </div>
        <form
          className="settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            try {
              await api('profile', {
                method: 'PATCH',
                body: body({ name, ...(password ? { password, currentPassword } : {}) }),
              });
              setPassword('');
              setCurrent('');
              await refresh();
              toast('Profile updated');
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setPending(false);
            }
          }}
        >
          <label>
            Full name
            <input
              required
              minLength={2}
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Email address
            <input value={user.email} disabled />
            <small>Your email identifies your account and workspace invitations.</small>
          </label>
          <div className="settings-divider" />
          <h3>Password & security</h3>
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
              placeholder="Required when changing password"
            />
          </label>
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 12 characters"
            />
            <small>Changing your password signs out your other sessions.</small>
          </label>
          <Button type="submit" disabled={pending}>
            {pending ? <Loader2 className="spin" size={15} /> : <Check size={15} />}Save changes
          </Button>
        </form>
        <div className="settings-divider" />
        <Button
          variant="outline"
          onClick={async () => {
            try {
              await api('auth/logout', { method: 'POST' });
              window.location.assign('/login');
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          <LogOut size={15} />
          Sign out
        </Button>
      </section>
      <div>
        <section className="panel members-panel">
          <div className="panel-heading">
            <div>
              <h2>
                Workspace members <span className="number-badge">{data.members.length}</span>
              </h2>
              <p>{data.workspace.name}</p>
            </div>
            {data.workspace.role !== 'MEMBER' && (
              <Button size="sm" variant="outline" onClick={invite}>
                <Plus size={14} />
                Invite
              </Button>
            )}
          </div>
          {data.members.map((m) => (
            <div className="member-row" key={m.user.id}>
              <span className="member-avatar">
                <Avatar person={m.user} />
                {online.includes(m.user.id) && <i />}
              </span>
              <div>
                <strong>
                  {m.user.name}
                  {m.user.id === user.id && <small> (you)</small>}
                </strong>
                <small>{m.user.email}</small>
              </div>
              <span className="role-badge">{m.role.toLowerCase()}</span>
            </div>
          ))}
          <p className="member-note">
            <ShieldCheck size={14} /> Only administrators can create invitation links.
          </p>
        </section>
        <section className="panel labels-panel">
          <div className="panel-heading">
            <div>
              <h2>A little organization</h2>
              <p>Labels that make your work easier to find.</p>
            </div>
          </div>
          <div className="settings-labels">
            {data.labels.map((l) => (
              <span
                key={l.id}
                className="tag"
                style={{ color: l.color, background: `${l.color}18` }}
              >
                {l.name}
              </span>
            ))}
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setPending(true);
              try {
                await api(scope('labels'), {
                  method: 'POST',
                  body: body({ name: labelName, color }),
                });
                setLabelName('');
                await refresh();
                toast('Label created');
              } catch (e) {
                toast((e as Error).message, true);
              } finally {
                setPending(false);
              }
            }}
          >
            <input
              aria-label="Label color"
              className="color-picker"
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
            <input
              aria-label="New label name"
              placeholder="New label name"
              required
              maxLength={30}
              value={labelName}
              onChange={(e) => setLabelName(e.target.value)}
            />
            <Button
              variant="outline"
              size="icon"
              disabled={pending}
              type="submit"
              aria-label="Create label"
            >
              <Plus size={15} />
            </Button>
          </form>
        </section>
        <div className="settings-note">
          <ShieldCheck size={22} />
          <h3>A space you can trust.</h3>
          <p>
            Your workspace is private to its members. Sessions are securely stored and checked on
            every request.
          </p>
        </div>
      </div>
    </div>
  );
}
