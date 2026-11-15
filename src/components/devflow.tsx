'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  ArrowUpRight,
  Bell,
  ChartNoAxesCombined,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Command,
  FolderKanban,
  GitBranch,
  GitFork as Github,
  LayoutDashboard,
  ListTodo,
  Loader2,
  Menu,
  Moon,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Sun,
  Users,
  Zap,
} from 'lucide-react';
import { api, body, usePreferences, useToasts, type View } from '@/lib/client';
import type { Person, Snapshot, Task, Workspace } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Avatar, Empty, Skeleton } from './common';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Dashboard, Analytics, ActivityFeed, ProjectList, TaskList } from './workspace-views';
import { Board } from './kanban';
import { TaskDialog, CreateProject, CreateTask } from './task-dialog';
import { Assistant, GitHub, Settings } from './integrations';
import { CommandPalette } from './palette';
import { Roadmap } from './roadmap';
const nav = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'my-tasks', label: 'Tasks', icon: ListTodo },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'board', label: 'Board', icon: ChartNoAxesCombined },
  { id: 'roadmap', label: 'Roadmap', icon: GitBranch },
  { id: 'analytics', label: 'Analytics', icon: Activity },
] as const;
const names: Record<View, string> = {
  overview: 'Overview',
  projects: 'Projects',
  board: 'Board',
  roadmap: 'Roadmap',
  'my-tasks': 'Tasks',
  analytics: 'Analytics',
  activity: 'Activity',
  github: 'GitHub',
  assistant: 'AI assistant',
  settings: 'Settings',
};
export function DevFlow({ user }: { user: Person }) {
  const client = useQueryClient();
  const toast = useToasts((s) => s.add);
  const { workspaceId, setWorkspace, theme, setTheme } = usePreferences();
  const [view, setView] = useState<View>('overview');
  const processedInvite = useRef<string | null>(null);
  const [projectId, setProject] = useState('all');
  const [taskId, setTask] = useState<string | null>(null);
  const [createTask, setCreateTask] = useState(false);
  const [createProject, setCreateProject] = useState(false);
  const [palette, setPalette] = useState(false);
  const [search, setSearch] = useState('');
  const [mobile, setMobile] = useState(false);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const [newWorkspace, setNewWorkspace] = useState(false);
  const [invite, setInvite] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [live, setLive] = useState(false);
  const [online, setOnline] = useState<string[]>([]);
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<{ user: Person; workspaces: Workspace[] }>('me'),
  });
  const selected = me.data?.workspaces.some((w) => w.id === workspaceId)
    ? workspaceId
    : me.data?.workspaces[0]?.id;
  const queryKey = ['snapshot', selected];
  const snapshot = useQuery({
    queryKey,
    queryFn: () => api<Snapshot>(`snapshot?workspaceId=${selected}`),
    enabled: !!selected,
    refetchInterval: 30000,
  });
  const data = snapshot.data;
  const scope = (route: string) => `${route}?workspaceId=${selected}`;
  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: ['snapshot'] });
    await client.invalidateQueries({ queryKey: ['task'] });
    await client.invalidateQueries({ queryKey: ['roadmap'] });
  }, [client]);
  const update = useMutation({
    mutationFn: ({ task, changes }: { task: Task; changes: Record<string, unknown> }) =>
      api<Task>(scope(`tasks/${task.id}`), {
        method: 'PATCH',
        body: body({ ...changes, version: task.version }),
      }),
    onMutate: async ({ task, changes }) => {
      await client.cancelQueries({ queryKey });
      const previous = client.getQueryData<Snapshot>(queryKey);
      client.setQueryData<Snapshot>(queryKey, (s) =>
        s ? { ...s, tasks: s.tasks.map((t) => (t.id === task.id ? { ...t, ...changes } : t)) } : s,
      );
      return { previous };
    },
    onError: (e, _variables, context) => {
      if (context?.previous) client.setQueryData(queryKey, context.previous);
      toast(e.message, true);
    },
    onSettled: refresh,
  });
  const navigate = useCallback((next: View) => {
    setView(next);
    setMobile(false);
    setSearch('');
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initial = params.get('view');
    const frame = window.requestAnimationFrame(() => {
      if (initial && Object.hasOwn(names, initial)) setView(initial as View);
    });
    const inviteToken = params.get('invite');
    if (inviteToken && processedInvite.current !== inviteToken) {
      processedInvite.current = inviteToken;
      void api<{ workspaceId: string }>('invites/accept', {
        method: 'POST',
        body: body({ token: inviteToken }),
      })
        .then((result) => {
          setWorkspace(result.workspaceId);
          void client.invalidateQueries({ queryKey: ['me'] });
          toast('You joined the workspace');
        })
        .catch((e) => toast(e.message, true));
      window.history.replaceState({}, '', '/');
    }
    return () => window.cancelAnimationFrame(frame);
  }, [client, setWorkspace, toast]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof HTMLElement &&
        !!event.target.closest('input,textarea,select,[contenteditable=true]');
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setPalette((p) => !p);
      }
      if (
        !typing &&
        !document.querySelector('[role=dialog]') &&
        !event.metaKey &&
        !event.ctrlKey &&
        event.key === 'c'
      ) {
        event.preventDefault();
        setCreateTask(true);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  useEffect(() => {
    if (!selected) return;
    const events = new EventSource(`/api/events?workspaceId=${selected}`);
    events.onopen = () => setLive(true);
    events.onerror = () => setLive(false);
    events.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        setOnline(payload.online ?? []);
        void refresh();
      } catch {}
    };
    const heartbeat = () =>
      void api(`heartbeat?workspaceId=${selected}`, { method: 'POST' }).catch(() => {});
    heartbeat();
    const timer = setInterval(heartbeat, 15000);
    return () => {
      events.close();
      clearInterval(timer);
      setLive(false);
    };
  }, [selected, refresh]);
  const activeProjects = data?.projects.filter((p) => !p.archivedAt) ?? [];
  const activeTaskCount =
    data?.tasks.filter(
      (t) => t.status !== 'DONE' && activeProjects.some((p) => p.id === t.projectId),
    ).length ?? 0;
  const chosenProject = data?.projects.find((p) => p.id === projectId);
  const visibleTasks =
    data?.tasks.filter(
      (t) =>
        (projectId === 'all'
          ? activeProjects.some((p) => p.id === t.projectId)
          : t.projectId === projectId) &&
        (!search ||
          `${t.title} ${t.description} DEV-${t.number}`
            .toLowerCase()
            .includes(search.toLowerCase())),
    ) ?? [];
  const openProject = (id: string) => {
    setProject(id);
    navigate('board');
  };
  const activeUser = me.data?.user ?? user;
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      {mobile && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={cn('sidebar', mobile && 'sidebar-open')}>
        <Link className="brand" href="/">
          <span className="brand-mark">
            <Command size={20} />
          </span>
          devflow<span className="brand-dot">®</span>
        </Link>
        <div className="workspace-switch">
          <button
            className="workspace-button"
            onClick={() => setWorkspaceMenu(!workspaceMenu)}
            aria-expanded={workspaceMenu}
          >
            <span className="workspace-avatar">{data?.workspace.name[0] ?? 'D'}</span>
            <span>
              <strong>{data?.workspace.name ?? 'Your workspace'}</strong>
              <small>Team workspace</small>
            </span>
            <ChevronsUpDown size={14} />
          </button>
          {workspaceMenu && (
            <div className="workspace-dropdown">
              {me.data?.workspaces.map((w) => (
                <button
                  key={w.id}
                  onClick={() => {
                    setWorkspace(w.id);
                    setProject('all');
                    setWorkspaceMenu(false);
                  }}
                >
                  {w.name}
                  {selected === w.id && <span className="live-dot" />}
                </button>
              ))}
              <button
                onClick={() => {
                  setNewWorkspace(true);
                  setWorkspaceMenu(false);
                }}
              >
                <Plus size={14} /> Create workspace
              </button>
            </div>
          )}
        </div>
        <button className="search-trigger" onClick={() => setPalette(true)}>
          <Search size={15} />
          <span>Search anything...</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {nav.map((item) => (
            <button
              key={item.id}
              onClick={() => navigate(item.id)}
              className={cn('nav-item', view === item.id && 'active')}
              aria-current={view === item.id ? 'page' : undefined}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === 'my-tasks' && activeTaskCount > 0 && (
                <span className="nav-count">{activeTaskCount}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-label nav-label-flex">
          YOUR PROJECTS
          <button onClick={() => setCreateProject(true)} aria-label="Create project">
            <Plus size={14} />
          </button>
        </div>
        <nav aria-label="Project navigation" className="project-nav">
          {activeProjects.slice(0, 6).map((p) => (
            <button
              key={p.id}
              className={cn('nav-item', view === 'board' && projectId === p.id && 'active')}
              onClick={() => openProject(p.id)}
            >
              <span className="project-dot" style={{ background: p.color }} />
              <span>{p.name}</span>
            </button>
          ))}
          {!activeProjects.length && (
            <button className="nav-item muted" onClick={() => setCreateProject(true)}>
              <Plus size={15} /> Your first project
            </button>
          )}
        </nav>
        <div className="nav-label">CONNECTED</div>
        <nav aria-label="Integrations">
          <button
            className={cn('nav-item', view === 'github' && 'active')}
            onClick={() => navigate('github')}
          >
            <Github size={18} />
            <span>GitHub</span>
            <ArrowUpRight size={13} />
          </button>
          <button
            className={cn('nav-item', view === 'assistant' && 'active')}
            onClick={() => navigate('assistant')}
          >
            <Sparkles size={18} />
            <span>AI assistant</span>
            <span className="beta-badge">BETA</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="flow-note">
            <span>
              <Zap size={15} /> Good work starts with focus.
            </span>
            <p>
              A little less noise.
              <br />A lot more momentum.
            </p>
            <button onClick={() => navigate('my-tasks')}>
              Find your next task <ArrowUpRight size={14} />
            </button>
          </div>
          <button
            className={cn('nav-item', view === 'settings' && 'active')}
            onClick={() => navigate('settings')}
          >
            <Settings2 size={17} />
            <span>Settings & members</span>
          </button>
          <button className="profile-button" onClick={() => navigate('settings')}>
            <Avatar person={activeUser} />
            <span>
              <strong>{activeUser.name}</strong>
              <small>{activeUser.email}</small>
            </span>
            <ChevronDown size={14} />
          </button>
        </div>
      </aside>
      <div className={cn('main-shell', view === 'assistant' && data && 'assistant-shell')}>
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobile(true)}
              aria-label="Open navigation"
            >
              <Menu size={19} />
            </button>
            <span className="breadcrumb-workspace">Workspace</span>
            <ChevronRight size={13} />
            <strong>{names[view]}</strong>
          </div>
          <div className="topbar-actions">
            <span className={cn('connection', live && 'connected')}>
              <span />
              {live ? 'Live workspace' : 'Reconnecting'}
            </span>
            <button
              className="icon-button theme-toggle"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <div className="notification-wrap">
              <button
                className="icon-button"
                aria-label="Notifications"
                aria-expanded={notifications}
                onClick={() => {
                  setNotifications(!notifications);
                  if (!notifications)
                    void api(scope('notifications/read'), { method: 'POST' })
                      .then(refresh)
                      .catch((e) => toast(e.message, true));
                }}
              >
                <Bell size={17} />
                {data?.notifications.some((n) => !n.readAt) && (
                  <span className="notification-dot" />
                )}
              </button>
              {notifications && (
                <div className="notification-panel">
                  <h3>Notifications</h3>
                  {data?.notifications.length ? (
                    data.notifications.map((n) => <p key={n.id}>{n.message}</p>)
                  ) : (
                    <p>You’re all caught up. We’ll let you know when a task is assigned to you.</p>
                  )}
                </div>
              )}
            </div>
            <span className="topbar-divider" />
            <Avatar person={activeUser} size="small" />
          </div>
        </header>
        <main id="main-content" className="content" tabIndex={-1}>
          {!data ? (
            snapshot.isError || me.isError ? (
              <Empty
                title="Your workspace is taking a moment"
                description={
                  (snapshot.error ?? me.error)?.message ?? 'Check the database connection.'
                }
                action={
                  <Button
                    onClick={() => {
                      void me.refetch();
                      void snapshot.refetch();
                    }}
                  >
                    Try again
                  </Button>
                }
              />
            ) : (
              <Skeleton />
            )
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={view}
                className={view === 'assistant' ? 'assistant-view' : undefined}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.16 }}
              >
                {view === 'overview' ? (
                  <Dashboard
                    data={data}
                    user={activeUser}
                    online={online}
                    openTask={setTask}
                    openProject={openProject}
                    onCreate={() => setCreateTask(true)}
                    navigate={navigate}
                  />
                ) : (
                  <>
                    {view !== 'assistant' && (
                      <div className="page-heading">
                        <div>
                          <span className="eyebrow">
                            {view === 'board'
                              ? 'MAKE PROGRESS VISIBLE'
                              : view === 'analytics'
                                ? 'THE BIGGER PICTURE'
                                : 'YOUR WORK, CONNECTED'}
                          </span>
                          <h1>
                            {names[view]}
                            <span className="heading-dot">.</span>
                          </h1>
                          <p>
                            {
                              (
                                {
                                  projects: 'Big ideas, moving forward. One project at a time.',
                                  board: 'A clear view of what’s next, and what’s moving.',
                                  roadmap: 'Connect the work. See the path to delivery.',
                                  analytics: 'Understand your momentum. Make every week better.',
                                  activity: 'The small steps behind the big things.',
                                  github: 'From your first commit to your next release.',
                                  assistant: 'Less blank-page thinking. More getting things done.',
                                  settings: 'A workspace that feels like you.',
                                  'my-tasks': 'Your workspace tasks, together in one place.',
                                } as Partial<Record<View, string>>
                              )[view]
                            }
                          </p>
                        </div>
                        <div className="heading-actions">
                          {['projects', 'board', 'my-tasks', 'roadmap'].includes(view) && (
                            <Button
                              disabled={view !== 'projects' && !!chosenProject?.archivedAt}
                              onClick={() =>
                                view === 'projects' ? setCreateProject(true) : setCreateTask(true)
                              }
                            >
                              <Plus size={16} />
                              {view === 'projects' ? 'New project' : 'New task'}
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                    {view === 'projects' && (
                      <ProjectList
                        openTask={setTask}
                        data={data}
                        openProject={openProject}
                        refresh={refresh}
                        scope={scope}
                        onCreate={() => setCreateProject(true)}
                      />
                    )}
                    {(view === 'board' || view === 'my-tasks') && (
                      <>
                        {chosenProject?.archivedAt && (
                          <p className="notice" style={{ marginBottom: 16 }}>
                            Archived project · You can inspect tasks here. Restore the project from
                            Projects to make changes.
                          </p>
                        )}
                        <div className="board-toolbar">
                          <div className="segmented">
                            <button
                              className={view === 'board' ? 'selected' : ''}
                              onClick={() => navigate('board')}
                            >
                              <FolderKanban size={14} /> Board
                            </button>
                            <button
                              className={view === 'my-tasks' ? 'selected' : ''}
                              onClick={() => navigate('my-tasks')}
                            >
                              <ListTodo size={14} /> List
                            </button>
                          </div>
                          <label className="search-field">
                            <Search size={15} />
                            <input
                              aria-label="Search tasks"
                              placeholder="Search tasks..."
                              value={search}
                              onChange={(e) => setSearch(e.target.value)}
                            />
                          </label>
                          <select
                            aria-label="Select project"
                            value={projectId}
                            onChange={(e) => setProject(e.target.value)}
                          >
                            <option value="all">All projects</option>
                            {chosenProject?.archivedAt && (
                              <option value={chosenProject.id}>
                                {chosenProject.name} (archived)
                              </option>
                            )}
                            {activeProjects.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        {view === 'board' ? (
                          <Board
                            tasks={visibleTasks}
                            data={data}
                            openTask={setTask}
                            move={(task, changes) => update.mutate({ task, changes })}
                            pending={update.isPending || !!chosenProject?.archivedAt}
                            create={() =>
                              chosenProject?.archivedAt
                                ? toast('Restore this project before adding tasks', true)
                                : setCreateTask(true)
                            }
                          />
                        ) : (
                          <TaskList
                            tasks={visibleTasks}
                            projects={activeProjects}
                            openTask={setTask}
                            emptyAction={() => setCreateTask(true)}
                          />
                        )}
                      </>
                    )}
                    {view === 'analytics' && <Analytics data={data} />}
                    {view === 'roadmap' && (
                      <Roadmap
                        data={data}
                        projectId={projectId}
                        setProject={setProject}
                        openTask={setTask}
                        scope={scope}
                        refresh={refresh}
                        createProject={() => setCreateProject(true)}
                      />
                    )}
                    {view === 'activity' && (
                      <div className="panel activity-page">
                        <ActivityFeed activities={data.activity} openTask={setTask} />
                      </div>
                    )}
                    {view === 'github' && (
                      <GitHub
                        key={data.workspace.id}
                        data={data}
                        scope={scope}
                        refresh={refresh}
                        openTask={setTask}
                      />
                    )}
                    {view === 'assistant' && (
                      <Assistant
                        data={data}
                        scope={scope}
                        refresh={refresh}
                        openTask={setTask}
                        selectedProjectId={projectId}
                      />
                    )}
                    {view === 'settings' && (
                      <Settings
                        user={activeUser}
                        data={data}
                        online={online}
                        invite={() => setInvite(true)}
                        scope={scope}
                        refresh={async () => {
                          await client.invalidateQueries({ queryKey: ['me'] });
                          await refresh();
                        }}
                      />
                    )}
                  </>
                )}
                {view !== 'assistant' && (
                  <footer className="page-footer">
                    <span>
                      <span className="footer-symbol">✳</span> A little less friction. A lot more
                      flow.
                    </span>
                    <span>Made for the way you work.</span>
                  </footer>
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </main>
      </div>
      <CommandPalette
        open={palette}
        setOpen={setPalette}
        data={data}
        navigate={navigate}
        openTask={setTask}
        openProject={openProject}
        createTask={() => setCreateTask(true)}
        createProject={() => setCreateProject(true)}
      />
      {data && (
        <>
          <CreateProject
            open={createProject}
            onOpenChange={setCreateProject}
            scope={scope}
            refresh={refresh}
          />
          <CreateTask
            open={createTask}
            onOpenChange={setCreateTask}
            data={data}
            projectId={projectId}
            scope={scope}
            refresh={refresh}
          />
          <TaskDialog
            id={taskId}
            onClose={() => setTask(null)}
            data={data}
            scope={scope}
            refresh={refresh}
          />
          <WorkspaceDialog
            open={newWorkspace}
            setOpen={setNewWorkspace}
            created={async (id) => {
              setWorkspace(id);
              setProject('all');
              await client.invalidateQueries({ queryKey: ['me'] });
            }}
          />
          <InviteDialog open={invite} setOpen={setInvite} scope={scope} />
        </>
      )}
    </div>
  );
}
function WorkspaceDialog({
  open,
  setOpen,
  created,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  created: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const toast = useToasts((s) => s.add);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="A new space to build"
      description="Create a workspace for your team or your next idea."
    >
      <form
        className="dialog-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          try {
            const w = await api<Workspace>('workspaces', { method: 'POST', body: body({ name }) });
            await created(w.id);
            setOpen(false);
            setName('');
            toast('Workspace created');
          } catch (e) {
            toast((e as Error).message, true);
          } finally {
            setPending(false);
          }
        }}
      >
        <label>
          Workspace name
          <input
            required
            minLength={2}
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Studio"
          />
        </label>
        <Button disabled={pending} type="submit">
          {pending ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}Create workspace
        </Button>
      </form>
    </Dialog>
  );
}
function InviteDialog({
  open,
  setOpen,
  scope,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  scope: (v: string) => string;
}) {
  const [email, setEmail] = useState('');
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState(false);
  const toast = useToasts((s) => s.add);
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setUrl('');
      }}
      title="Great work is a team sport"
      description="Create a 7-day invitation link. Share it with the person at this email address."
    >
      <form
        className="dialog-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          try {
            const result = await api<{ url: string }>(scope('invites'), {
              method: 'POST',
              body: body({ email }),
            });
            setUrl(result.url);
          } catch (e) {
            toast((e as Error).message, true);
          } finally {
            setPending(false);
          }
        }}
      >
        <label>
          Team member’s email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
          />
        </label>
        <Button disabled={pending} type="submit">
          <Users size={15} />
          Create invitation
        </Button>
        {url && (
          <div className="invite-result">
            <p>
              Ask your teammate to sign in with <strong>{email}</strong> and open this link.
            </p>
            <input
              aria-label="Invitation link"
              value={url}
              readOnly
              onFocus={(e) => e.target.select()}
            />
            <Button
              variant="outline"
              type="button"
              onClick={() =>
                void navigator.clipboard
                  .writeText(url)
                  .then(() => toast('Invitation copied'))
                  .catch(() => toast('Select and copy the link manually', true))
              }
            >
              Copy invitation link
            </Button>
          </div>
        )}
      </form>
    </Dialog>
  );
}
