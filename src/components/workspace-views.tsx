'use client';
import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronRight,
  CircleCheck,
  Clock3,
  Folder,
  FolderKanban,
  Layers,
  Plus,
  ArchiveRestore as Restore,
  Target,
  TrendingUp,
  Users,
  Zap,
  Archive,
} from 'lucide-react';
import { analytics } from '@/lib/analytics';
import type { Activity, Person, Project, Snapshot, Task } from '@/lib/types';
import type { View } from '@/lib/client';
import { api, body, useToasts } from '@/lib/client';
import { cn, relativeDate, shortDate } from '@/lib/utils';
import { Avatar, Empty, PriorityIcon, StatusIcon } from './common';
import { Button } from './ui/button';
import { GitHubWorkflowSettings } from './github-workflow-settings';
const tooltipStyle = {
  background: 'var(--surface-raised)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  fontSize: 'var(--font-size-description)',
  color: 'var(--text)',
};
export function Dashboard({
  data,
  user,
  online,
  openTask,
  openProject,
  onCreate,
  navigate,
}: {
  data: Snapshot;
  user: Person;
  online: string[];
  openTask: (id: string) => void;
  openProject: (id: string) => void;
  onCreate: () => void;
  navigate: (view: View) => void;
}) {
  const metrics = useMemo(() => analytics(data.tasks, data.projects), [data]);
  const first = user.name.split(' ')[0];
  const focus = data.tasks
    .filter(
      (t) => t.status !== 'DONE' && !data.projects.find((p) => p.id === t.projectId)?.archivedAt,
    )
    .sort(
      (a, b) =>
        Number(b.assigneeId === user.id) - Number(a.assigneeId === user.id) ||
        ['URGENT', 'HIGH', 'MEDIUM', 'LOW'].indexOf(a.priority) -
          ['URGENT', 'HIGH', 'MEDIUM', 'LOW'].indexOf(b.priority),
    )
    .slice(0, 5);
  const weekly = metrics.days.reduce((n, d) => n + d.completed, 0);
  return (
    <>
      <div className="overview-heading">
        <div>
          <div className="eyebrow">
            <span className="live-dot" /> LET’S MAKE GOOD THINGS HAPPEN
          </div>
          <h1>
            Welcome back, {first}
            <span className="heading-dot">.</span>
          </h1>
          <p>Here’s what’s moving in your workspace today.</p>
        </div>
        <div className="heading-actions">
          <span className="date-pill">
            <CalendarDays size={14} />
            {new Date().toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </span>
          <Button onClick={onCreate}>
            <Plus size={16} />
            New task
          </Button>
        </div>
      </div>
      <section className="flow-banner">
        <div className="banner-content">
          <span className="banner-eyebrow">
            <Zap size={13} /> IN YOUR FLOW
          </span>
          <h2>
            Small steps.
            <br />
            <span>Remarkable progress.</span>
          </h2>
          <p>
            {weekly
              ? `${weekly} task${
                  weekly === 1 ? '' : 's'
                } completed this week. Keep the momentum going.`
              : 'A fresh week of possibilities. Your next great move starts here.'}
          </p>
          <button onClick={() => navigate('my-tasks')}>
            Let’s get to work <ArrowUpRight size={15} />
          </button>
        </div>
        <div className="flow-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="orbit orbit-three" />
          <div className="flow-sphere">
            <span>✳</span>
          </div>
          <div className="art-chip art-chip-one">
            <Check size={12} /> In motion
          </div>
          <div className="art-chip art-chip-two">
            <span className="live-dot" /> Ideas into impact
          </div>
          <div className="star star-one">✦</div>
          <div className="star star-two">✧</div>
        </div>
        <div className="banner-progress">
          <div className="banner-progress-top">
            <span>This week’s wins</span>
            <TrendingUp size={16} />
          </div>
          <strong>
            {weekly}
            <span> tasks completed</span>
          </strong>
          <div className="week-bars">
            {metrics.days.map((d) => (
              <div key={d.day} title={`${d.day}: ${d.completed} completed`}>
                <span style={{ height: `${12 + Math.min(45, d.completed * 8)}px` }} />
                <small>{d.day[0]}</small>
              </div>
            ))}
          </div>
          <p>Every step counts. You’ve got this.</p>
        </div>
      </section>
      <StatCards metrics={metrics} />
      <div className="dashboard-grid">
        <section className="panel productivity-panel">
          <div className="panel-heading">
            <div>
              <h2>
                Productivity pulse <span className="little-dot" />
              </h2>
              <p>A little progress, every day.</p>
            </div>
            <span className="period-pill">
              Last 7 days <ChevronRight size={12} />
            </span>
          </div>
          <div className="chart-legend">
            <span>
              <i style={{ background: '#bba2f6' }} />
              Completed
            </span>
            <span>
              <i style={{ background: '#596b8b' }} />
              Created
            </span>
            <strong>
              {weekly}
              <small> completed this week</small>
            </strong>
          </div>
          <ProductivityChart days={metrics.days} />
        </section>
        <section className="panel team-panel">
          <div className="panel-heading">
            <div>
              <h2>Your people</h2>
              <p>Better together.</p>
            </div>
            <Users size={17} />
          </div>
          <div className="team-avatar-stack">
            {data.members.slice(0, 5).map((m) => (
              <span key={m.user.id}>
                <Avatar person={m.user} size="large" />
                {online.includes(m.user.id) && <i />}
              </span>
            ))}
          </div>
          <h3>
            {data.members.length} brilliant mind{data.members.length === 1 ? '' : 's'}.<br />
            One shared direction.
          </h3>
          <p>
            <span className="live-dot" />
            {online.length} online right now
          </p>
          <div className="team-members-mini">
            {data.members.slice(0, 3).map((m) => (
              <div key={m.user.id}>
                <span>{m.user.name}</span>
                <span>{m.role.toLowerCase()}</span>
              </div>
            ))}
          </div>
          <button className="panel-link" onClick={() => navigate('settings')}>
            Meet your team <ArrowUpRight size={14} />
          </button>
        </section>
      </div>
      <div className="dashboard-bottom">
        <section className="panel focus-panel">
          <div className="panel-heading">
            <div>
              <h2>
                Your next moves <span className="number-badge">{focus.length}</span>
              </h2>
              <p>A little focus goes a long way.</p>
            </div>
            <button className="text-link" onClick={() => navigate('board')}>
              View all <ArrowUpRight size={13} />
            </button>
          </div>
          {focus.length ? (
            <div className="focus-list">
              {focus.map((t) => (
                <button key={t.id} className="focus-row" onClick={() => openTask(t.id)}>
                  <StatusIcon status={t.status} />
                  <span className="focus-task-name">
                    <strong>{t.title}</strong>
                    <small>
                      {data.projects.find((p) => p.id === t.projectId)?.name} <span>·</span> DEV–
                      {String(t.number).padStart(3, '0')}
                    </small>
                  </span>
                  <span className={`priority-label priority-${t.priority}`}>
                    <PriorityIcon priority={t.priority} />
                    {t.priority.toLowerCase()}
                  </span>
                  {t.assignee && <Avatar person={t.assignee} size="small" />}
                  <ChevronRight size={13} />
                </button>
              ))}
            </div>
          ) : (
            <Empty
              title="A clear runway"
              description="Create your first task and turn an idea into momentum."
              action={
                <Button size="sm" onClick={onCreate}>
                  <Plus size={14} />
                  New task
                </Button>
              }
            />
          )}
        </section>
        <section className="panel activity-panel">
          <div className="panel-heading">
            <div>
              <h2>Around the workspace</h2>
              <p>The latest, without the noise.</p>
            </div>
            <span className="live-dot" />
          </div>
          <ActivityFeed activities={data.activity.slice(0, 4)} openTask={openTask} />
          <button className="panel-link" onClick={() => navigate('activity')}>
            All activity <ArrowRight size={14} />
          </button>
        </section>
      </div>
      <section className="projects-section">
        <div className="section-heading">
          <div>
            <h2>Ideas in motion</h2>
            <p>A few things we’re making happen.</p>
          </div>
          <button className="text-link" onClick={() => navigate('projects')}>
            All projects <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="project-grid">
          {metrics.health.slice(0, 3).map((h) => (
            <ProjectCard
              key={h.project.id}
              project={h.project}
              total={h.total}
              completed={h.completed}
              overdue={h.overdue}
              open={() => openProject(h.project.id)}
            />
          ))}
          {!metrics.health.length && (
            <button className="project-empty" onClick={() => navigate('projects')}>
              <Plus size={20} />
              <span>Your next big idea goes here</span>
            </button>
          )}
        </div>
      </section>
    </>
  );
}
function StatCards({ metrics }: { metrics: ReturnType<typeof analytics> }) {
  const items = [
    {
      label: 'Active projects',
      value: metrics.projects,
      icon: FolderKanban,
      color: 'violet',
      foot: 'Ideas taking shape',
    },
    {
      label: 'In the works',
      value: metrics.active,
      icon: Layers,
      color: 'blue',
      foot: 'One step at a time',
    },
    {
      label: 'Completed tasks',
      value: metrics.completed,
      icon: CircleCheck,
      color: 'green',
      foot: `${metrics.rate}% completion rate`,
    },
    {
      label: 'Needs attention',
      value: metrics.overdue,
      icon: Clock3,
      color: 'amber',
      foot: metrics.overdue ? 'Past their due date' : 'Everything on track',
    },
  ];
  return (
    <div className="stat-grid">
      {items.map((s) => (
        <section className="stat-card" key={s.label}>
          <div className="stat-top">
            <span>{s.label}</span>
            <span className={cn('stat-icon', s.color)}>
              <s.icon size={16} />
            </span>
          </div>
          <div className="stat-value">
            {String(s.value).padStart(2, '0')}
            <span className={cn('stat-trend', s.color)}>
              {s.label === 'Needs attention' ? (
                s.value ? (
                  <Clock3 size={13} />
                ) : (
                  <Check size={13} />
                )
              ) : (
                <ArrowUpRight size={14} />
              )}
            </span>
          </div>
          <p>{s.foot}</p>
        </section>
      ))}
    </div>
  );
}
function ProductivityChart({ days }: { days: ReturnType<typeof analytics>['days'] }) {
  return (
    <div
      className="productivity-chart"
      role="img"
      aria-label={`Tasks over seven days. ${days
        .map((d) => `${d.day}: ${d.completed} completed, ${d.created} created`)
        .join('; ')}`}
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 320, height: 189 }}
      >
        <AreaChart data={days} margin={{ top: 12, right: 12, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id="completed-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ad8cef" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#ad8cef" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" vertical={false} strokeDasharray="3 5" />
          <XAxis
            dataKey="day"
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'var(--muted)', fontSize: 'var(--font-size-caption)' }}
            dy={10}
          />
          <YAxis
            allowDecimals={false}
            axisLine={false}
            tickLine={false}
            tick={{ fill: 'var(--muted)', fontSize: 'var(--font-size-caption)' }}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ stroke: 'var(--muted)', strokeDasharray: '3 3' }}
          />
          <Area
            type="monotone"
            dataKey="created"
            name="Created"
            stroke="#596b8b"
            strokeWidth={2}
            fill="transparent"
            strokeDasharray="4 4"
          />
          <Area
            type="monotone"
            dataKey="completed"
            name="Completed"
            stroke="#bba2f6"
            strokeWidth={2.5}
            fill="url(#completed-gradient)"
            activeDot={{ r: 5, strokeWidth: 4, stroke: 'var(--surface)' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
export function ActivityFeed({
  activities,
  openTask,
}: {
  activities: Activity[];
  openTask: (id: string) => void;
}) {
  return (
    <div className="activity-feed">
      {activities.length ? (
        activities.map((a) => (
          <div className="activity-item" key={a.id}>
            {a.actor ? (
              <Avatar person={a.actor} size="small" />
            ) : (
              <span className="automation-avatar" aria-label="GitHub automation">
                <Zap size={15} />
              </span>
            )}
            <div>
              <p>
                <strong>
                  {a.source === 'GITHUB_AUTOMATION'
                    ? 'GitHub automation'
                    : (a.actor?.name ?? 'Former member')}
                </strong>{' '}
                {a.taskId ? (
                  <button onClick={() => openTask(a.taskId!)}>{a.message}</button>
                ) : (
                  a.message
                )}
              </p>
              <time>{relativeDate(a.createdAt)}</time>
            </div>
          </div>
        ))
      ) : (
        <div className="quiet-state">
          A fresh start.
          <br />
          Your team’s activity will appear here.
        </div>
      )}
    </div>
  );
}
function ProjectCard({
  project,
  total,
  completed,
  overdue,
  open,
  children,
}: {
  project: Project;
  total: number;
  completed: number;
  overdue: number;
  open: () => void;
  children?: React.ReactNode;
}) {
  const percent = total ? Math.round((completed / total) * 100) : 0;
  return (
    <article className="project-card">
      <div className="project-card-top">
        <span
          className="project-icon"
          style={{ background: `${project.color}15`, color: project.color }}
        >
          <Folder size={19} />
        </span>
        <span className={cn('health-badge', overdue && 'health-risk')}>
          {project.archivedAt ? 'Archived' : overdue ? 'Needs attention' : 'On track'}
        </span>
        {children}
      </div>
      <button className="project-open" onClick={open}>
        <h3>
          {project.name}
          <ArrowUpRight size={15} />
        </h3>
        <p>{project.description || 'The beginning of something good.'}</p>
      </button>
      <div className="project-progress">
        <span style={{ width: `${percent}%`, background: project.color }} />
      </div>
      <div className="project-card-footer">
        <span>
          <CheckCheck size={13} />
          {completed} / {total} tasks
        </span>
        <span>{percent}%</span>
      </div>
    </article>
  );
}
export function ProjectList({
  data,
  openProject,
  refresh,
  scope,
  onCreate,
  openTask,
}: {
  data: Snapshot;
  openTask?: (id: string) => void;
  openProject: (id: string) => void;
  refresh: () => Promise<void>;
  scope: (v: string) => string;
  onCreate: () => void;
}) {
  const [archived, setArchived] = useState(false);
  const [workflowProject, setWorkflowProject] = useState<Project | null>(null);
  const [pending, setPending] = useState('');
  const toast = useToasts((s) => s.add);
  const projects = data.projects.filter((p) => !!p.archivedAt === archived);
  return (
    <>
      {workflowProject && (
        <GitHubWorkflowSettings
          key={workflowProject.id}
          projectId={workflowProject.id}
          projectName={workflowProject.name}
          openTask={openTask}
          scope={scope}
          onClose={() => setWorkflowProject(null)}
        />
      )}
      <div className="projects-tabs">
        <div className="segmented">
          <button className={!archived ? 'selected' : ''} onClick={() => setArchived(false)}>
            Active projects <span>{data.projects.filter((p) => !p.archivedAt).length}</span>
          </button>
          <button className={archived ? 'selected' : ''} onClick={() => setArchived(true)}>
            <Archive size={14} />
            Archived
          </button>
        </div>
      </div>
      {projects.length ? (
        <div className="project-grid project-grid-full">
          {projects.map((p) => {
            const tasks = data.tasks.filter((t) => t.projectId === p.id);
            return (
              <ProjectCard
                key={p.id}
                project={p}
                total={tasks.length}
                completed={tasks.filter((t) => t.status === 'DONE').length}
                overdue={
                  tasks.filter(
                    (t) => t.status !== 'DONE' && t.dueDate && new Date(t.dueDate) < new Date(),
                  ).length
                }
                open={() => openProject(p.id)}
              >
                {data.workspace.role !== 'MEMBER' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setWorkflowProject(p)}
                    aria-label={`GitHub workflow settings for ${p.name}`}
                  >
                    Workflow rules
                  </Button>
                )}
                <button
                  title={archived ? 'Restore project' : 'Archive project'}
                  aria-label={`${archived ? 'Restore' : 'Archive'} ${p.name}`}
                  className="icon-button"
                  disabled={pending === p.id}
                  onClick={async () => {
                    setPending(p.id);
                    try {
                      await api(scope(`projects/${p.id}`), {
                        method: 'PATCH',
                        body: body({ archived: !archived }),
                      });
                      await refresh();
                      toast(archived ? 'Project restored' : 'Project archived');
                    } catch (e) {
                      toast((e as Error).message, true);
                    } finally {
                      setPending('');
                    }
                  }}
                >
                  {archived ? <Restore size={14} /> : <Archive size={14} />}
                </button>
              </ProjectCard>
            );
          })}
        </div>
      ) : (
        <Empty
          title={archived ? 'No archived projects' : 'Make room for your next idea'}
          description={
            archived
              ? 'Archived projects will be kept here, ready when you need them.'
              : 'Create a project to organize tasks and bring your team together.'
          }
          action={
            !archived && (
              <Button onClick={onCreate}>
                <Plus size={15} />
                New project
              </Button>
            )
          }
        />
      )}
    </>
  );
}
export function TaskList({
  tasks,
  projects,
  openTask,
  emptyAction,
}: {
  tasks: Task[];
  projects: Project[];
  openTask: (id: string) => void;
  emptyAction: () => void;
}) {
  const [status, setStatus] = useState('active');
  const filtered = tasks.filter(
    (t) => status === 'all' || (status === 'done' ? t.status === 'DONE' : t.status !== 'DONE'),
  );
  return (
    <>
      <div className="filter-row">
        <div className="segmented">
          <button
            onClick={() => setStatus('active')}
            className={status === 'active' ? 'selected' : ''}
          >
            Active
          </button>
          <button onClick={() => setStatus('done')} className={status === 'done' ? 'selected' : ''}>
            Completed
          </button>
          <button onClick={() => setStatus('all')} className={status === 'all' ? 'selected' : ''}>
            All
          </button>
        </div>
        <small>{filtered.length} tasks</small>
      </div>
      {filtered.length ? (
        <div className="panel task-table">
          <div className="task-table-head">
            <span>Task</span>
            <span>Priority</span>
            <span>Due date</span>
            <span>Assignee</span>
          </div>
          {filtered.map((t) => (
            <button className="task-table-row" key={t.id} onClick={() => openTask(t.id)}>
              <span>
                <StatusIcon status={t.status} />
                <span>
                  <strong>{t.title}</strong>
                  <small>
                    DEV–{String(t.number).padStart(3, '0')} ·{' '}
                    {projects.find((p) => p.id === t.projectId)?.name}
                  </small>
                </span>
              </span>
              <span>
                <PriorityIcon priority={t.priority} />
                {t.priority.toLowerCase()}
              </span>
              <span
                className={
                  t.dueDate && t.status !== 'DONE' && new Date(t.dueDate) < new Date()
                    ? 'overdue'
                    : ''
                }
              >
                {t.dueDate ? shortDate(t.dueDate) : 'No date'}
              </span>
              <span>{t.assignee ? <Avatar person={t.assignee} size="small" /> : '—'}</span>
            </button>
          ))}
        </div>
      ) : (
        <Empty
          title="A little breathing room"
          description="No matching tasks. Create a task or adjust your filters to see work here."
          action={
            <Button onClick={emptyAction}>
              <Plus size={15} />
              Create task
            </Button>
          }
        />
      )}
    </>
  );
}
export function Analytics({ data }: { data: Snapshot }) {
  const metrics = useMemo(() => analytics(data.tasks, data.projects), [data]);
  const colors = ['#f87171', '#fbbf73', '#bba2f6', '#6eb9de'];
  return (
    <>
      <StatCards metrics={metrics} />
      <div className="analytics-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>The week in motion</h2>
              <p>Created and completed tasks, by day (UTC).</p>
            </div>
            <TrendingUp size={19} />
          </div>
          <div className="analytics-chart">
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 320, height: 240 }}
            >
              <BarChart data={metrics.days} margin={{ left: -8, right: 12, top: 10, bottom: 5 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="day"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: 'var(--muted)', fontSize: 'var(--font-size-caption)' }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                  tick={{ fill: 'var(--muted)', fontSize: 'var(--font-size-caption)' }}
                />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="created" fill="#4d596e" radius={[4, 4, 0, 0]} name="Created" />
                <Bar dataKey="completed" fill="#bba2f6" radius={[4, 4, 0, 0]} name="Completed" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-legend chart-legend-center">
            <span>
              <i style={{ background: '#4d596e' }} />
              Created
            </span>
            <span>
              <i style={{ background: '#bba2f6' }} />
              Completed
            </span>
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>A question of priority</h2>
              <p>Active work, by importance.</p>
            </div>
            <Target size={18} />
          </div>
          {metrics.active ? (
            <>
              <div className="priority-chart">
                <ResponsiveContainer
                  width="100%"
                  height="100%"
                  initialDimension={{ width: 270, height: 205 }}
                >
                  <PieChart>
                    <Pie
                      data={metrics.priorities}
                      dataKey="value"
                      innerRadius={60}
                      outerRadius={85}
                      paddingAngle={5}
                      stroke="none"
                    >
                      {metrics.priorities.map((p, i) => (
                        <Cell key={p.name} fill={colors[i]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="donut-label">
                  <strong>{metrics.active}</strong>
                  <span>active tasks</span>
                </div>
              </div>
              <div className="priority-legend">
                {metrics.priorities.map((p, i) => (
                  <span key={p.name}>
                    <i style={{ background: colors[i] }} />
                    {p.name.toLowerCase()}
                    <strong>{p.value}</strong>
                  </span>
                ))}
              </div>
            </>
          ) : (
            <Empty
              title="A clear horizon"
              description="Add tasks to see your priority breakdown."
            />
          )}
        </section>
      </div>
      <section className="panel health-panel">
        <div className="panel-heading">
          <div>
            <h2>Project health</h2>
            <p>The right context for your next decision.</p>
          </div>
          <span className="period-pill">Live records</span>
        </div>
        {metrics.health.length ? (
          metrics.health.map((h) => (
            <div className="health-row" key={h.project.id}>
              <span className="project-dot" style={{ background: h.project.color }} />
              <strong>{h.project.name}</strong>
              <span>
                {h.completed} / {h.total} complete
              </span>
              <div className="project-progress">
                <span
                  style={{
                    width: `${h.total ? (h.completed / h.total) * 100 : 0}%`,
                    background: h.project.color,
                  }}
                />
              </div>
              <span className={cn('health-badge', h.overdue && 'health-risk')}>
                {h.overdue ? `${h.overdue} overdue` : 'On track'}
              </span>
            </div>
          ))
        ) : (
          <p className="quiet-state">Create a project to start measuring progress.</p>
        )}
      </section>
      <div className="analytics-bottom">
        <section className="panel completion-panel">
          <span className="stat-icon green">
            <CheckCheck size={20} />
          </span>
          <div>
            <h2>{metrics.rate}%</h2>
            <p>Overall completion rate</p>
            <small>Completed tasks ÷ all tasks in active projects</small>
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Team contributions</h2>
              <p>Current task ownership, from your workspace.</p>
            </div>
          </div>
          {data.members.map((m) => {
            const assigned = data.tasks.filter(
              (t) =>
                t.assigneeId === m.user.id &&
                !data.projects.find((p) => p.id === t.projectId)?.archivedAt,
            );
            return (
              <div className="contribution-row" key={m.user.id}>
                <Avatar person={m.user} size="small" />
                <strong>{m.user.name}</strong>
                <span>{assigned.filter((t) => t.status === 'DONE').length} completed</span>
                <small>{assigned.filter((t) => t.status !== 'DONE').length} active</small>
              </div>
            );
          })}
        </section>
      </div>
    </>
  );
}
