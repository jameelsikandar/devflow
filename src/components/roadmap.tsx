'use client';
import './roadmap.css';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Diamond,
  Flag,
  GitBranch,
  GripVertical,
  Plus,
  X,
} from 'lucide-react';
import { api, body, useToasts } from '@/lib/client';
import type { RoadmapData, Snapshot, Task } from '@/lib/types';
import {
  criticalPath,
  deadlineWarnings,
  dayISO,
  shiftSchedule,
  utcDay,
  type Dependency,
} from '@/lib/roadmap';
import { cn } from '@/lib/utils';
import { Empty, Skeleton, StatusIcon } from './common';
import { Button } from './ui/button';

const scales = {
  day: { days: 42, pixels: 32, step: 1 },
  week: { days: 112, pixels: 12, step: 7 },
  month: { days: 365, pixels: 4, step: 30 },
};
type Zoom = keyof typeof scales;
const dateLabel = (day: number) =>
  new Date(dayISO(day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

export function Roadmap({
  data,
  projectId,
  setProject,
  openTask,
  scope,
  refresh,
  createProject,
}: {
  data: Snapshot;
  projectId: string;
  setProject: (id: string) => void;
  openTask: (id: string) => void;
  scope: (route: string) => string;
  refresh: () => Promise<void>;
  createProject: () => void;
}) {
  const selected =
    projectId === 'all' ? (data.projects.find((p) => !p.archivedAt)?.id ?? '') : projectId;
  const query = useQuery({
    queryKey: ['roadmap', data.workspace.id, selected],
    queryFn: () =>
      api<RoadmapData>(`${scope('roadmap')}&projectId=${encodeURIComponent(selected)}`),
    enabled: !!selected,
  });
  return (
    <div className="roadmap-view">
      <div className="roadmap-project-picker">
        <label>
          Project{' '}
          <select
            aria-label="Roadmap project"
            value={selected}
            onChange={(e) => setProject(e.target.value)}
          >
            {!selected && <option value="">Choose a project</option>}
            {data.projects
              .filter((p) => !p.archivedAt || p.id === selected)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.archivedAt ? ' (archived)' : ''}
                </option>
              ))}
          </select>
        </label>
        <span>
          <span className="live-dot" /> Connected to project tasks
        </span>
      </div>
      {!selected ? (
        <Empty
          title="A plan starts with a project"
          description="Create a project, add tasks, then map out the work ahead."
          action={
            <Button onClick={createProject}>
              <Plus size={15} /> Create project
            </Button>
          }
        />
      ) : query.isError ? (
        <div className="configuration-message" role="alert">
          <h3>Could not load the roadmap</h3>
          <p>{query.error.message}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : !query.data ? (
        <Skeleton />
      ) : (
        <ProjectRoadmap
          key={`${data.workspace.id}:${selected}`}
          roadmap={query.data}
          openTask={openTask}
          scope={scope}
          refresh={refresh}
        />
      )}
    </div>
  );
}

function ProjectRoadmap({
  roadmap,
  openTask,
  scope,
  refresh,
}: {
  roadmap: RoadmapData;
  openTask: (id: string) => void;
  scope: (route: string) => string;
  refresh: () => Promise<void>;
}) {
  const [zoom, setZoom] = useState<Zoom>('week');
  const [mode, setMode] = useState<'gantt' | 'timeline'>('gantt');
  const [origin, setOrigin] = useState(() => {
    const starts = roadmap.tasks.filter((t) => t.startDate).map((t) => utcDay(t.startDate!));
    return starts.length ? Math.min(...starts) - 3 : utcDay(new Date()) - 7;
  });
  const [selectedId, setSelectedId] = useState(roadmap.tasks[0]?.id ?? '');
  const [critical, setCritical] = useState(true);
  const [predecessorId, setPredecessor] = useState('');
  const [successorId, setSuccessor] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const toast = useToasts((s) => s.add);
  const archived = !!roadmap.project.archivedAt;
  const { days, pixels, step } = scales[zoom];
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const tasks =
    mode === 'timeline'
      ? [...roadmap.tasks].sort(
          (a, b) =>
            (a.startDate ?? '9999').localeCompare(b.startDate ?? '9999') || a.number - b.number,
        )
      : roadmap.tasks;
  const cpm = criticalPath(roadmap.tasks, roadmap.dependencies);
  const warnings = deadlineWarnings(roadmap.tasks, roadmap.dependencies);
  const done = tasks.filter((t) => t.status === 'DONE').length;
  const progress = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const selected = tasks.find((t) => t.id === selectedId);
  const save = useMutation({
    mutationFn: ({ task, changes }: { task: Task; changes: Record<string, unknown> }) =>
      api<Task>(scope(`tasks/${task.id}`), {
        method: 'PATCH',
        body: body({ ...changes, version: task.version }),
      }),
    onSuccess: async (task) => {
      await refresh();
      setAnnouncement(`Schedule saved for ${task.title}`);
      toast('Schedule saved');
    },
    onError: async (error) => {
      toast(error.message, true);
      setAnnouncement(error.message);
      await refresh();
    },
  });
  const edge = useMutation({
    mutationFn: ({ dependency, remove }: { dependency: Dependency; remove?: boolean }) =>
      api(scope('roadmap/dependencies'), {
        method: remove ? 'DELETE' : 'POST',
        // Loaded dependency records also contain read-only metadata (createdAt).
        // Send only the command fields accepted by the strict API schema.
        body: body({
          projectId: dependency.projectId,
          predecessorId: dependency.predecessorId,
          successorId: dependency.successorId,
        }),
      }),
    onSuccess: async () => {
      await refresh();
      toast('Dependencies updated');
    },
    onError: (error) => toast(error.message, true),
  });
  const pending = save.isPending || edge.isPending;
  const width = days * pixels;
  const todayX = (utcDay(new Date()) - origin) * pixels;
  return (
    <>
      <div className="roadmap-summary">
        <div>
          <span className="eyebrow">DELIVERY OVERVIEW</span>
          <h2>{roadmap.project.name}</h2>
          <p>
            {done} of {tasks.length} tasks completed · {tasks.filter((t) => t.isMilestone).length}{' '}
            milestones
          </p>
        </div>
        <div className="roadmap-progress">
          <strong>{progress}%</strong>
          <progress aria-label="Project completion" max={100} value={progress} />
        </div>
        <div className="roadmap-deadline">
          <Flag size={17} />
          <strong>{warnings.overdue.length}</strong>
          <span>overdue</span>
          <strong>{warnings.approaching.length}</strong>
          <span>due within 3 days</span>
        </div>
      </div>
      {archived && (
        <p className="notice">Archived project · Restore it from Projects to edit its roadmap.</p>
      )}
      <section className="panel roadmap-panel" aria-label="Project roadmap">
        <div className="roadmap-toolbar">
          <div className="segmented" aria-label="Roadmap layout">
            <button
              onClick={() => setMode('gantt')}
              aria-pressed={mode === 'gantt'}
              className={mode === 'gantt' ? 'selected' : ''}
            >
              <GitBranch size={14} />
              Gantt
            </button>
            <button
              onClick={() => setMode('timeline')}
              aria-pressed={mode === 'timeline'}
              className={mode === 'timeline' ? 'selected' : ''}
            >
              <CalendarDays size={14} />
              Timeline
            </button>
          </div>
          <div className="roadmap-date-navigation">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Previous roadmap period"
              onClick={() => setOrigin((o) => o - Math.floor(days / 2))}
            >
              <ArrowLeft size={15} />
            </Button>
            <Button size="sm" variant="outline" onClick={() => setOrigin(utcDay(new Date()) - 7)}>
              Today
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Next roadmap period"
              onClick={() => setOrigin((o) => o + Math.floor(days / 2))}
            >
              <ArrowRight size={15} />
            </Button>
            <span>
              {dateLabel(origin)} – {dateLabel(origin + days - 1)},{' '}
              {new Date(dayISO(origin + days - 1)).getUTCFullYear()}
            </span>
          </div>
          <label className="roadmap-critical-toggle">
            <input
              type="checkbox"
              checked={critical}
              disabled={!cpm.complete}
              onChange={(e) => setCritical(e.target.checked)}
            />{' '}
            Critical path
          </label>
          <select
            aria-label="Timeline zoom"
            value={zoom}
            onChange={(e) => setZoom(e.target.value as Zoom)}
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </div>
        <p className="roadmap-help">
          Drag a bar by its grip to shift dates. Select a task to schedule with date controls. Dates
          are UTC; dependencies do not automatically move other tasks.
        </p>
        {!tasks.length ? (
          <Empty
            title="Room for your next milestone"
            description="Create tasks using New task, then set their start and due dates here."
          />
        ) : (
          <DndContext
            sensors={sensors}
            onDragEnd={({ active, delta }) => {
              const task = tasks.find((t) => t.id === active.id);
              const shift = Math.round(delta.x / pixels);
              if (!task || !shift || archived || pending) return;
              save.mutate({ task, changes: shiftSchedule(task, shift) });
            }}
          >
            <div
              className="roadmap-scroll"
              tabIndex={0}
              role="region"
              aria-label="Scrollable project timeline"
            >
              <div className="roadmap-canvas" style={{ width: width + 260 }}>
                <div className="roadmap-axis">
                  <span className="roadmap-axis-label">
                    {mode === 'gantt' ? 'PROJECT TASKS' : 'CHRONOLOGICAL TIMELINE'}
                  </span>
                  <div style={{ width }}>
                    {Array.from({ length: Math.ceil(days / step) }, (_, i) => (
                      <span key={i} style={{ left: i * step * pixels, width: step * pixels }}>
                        {dateLabel(origin + i * step)}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="roadmap-rows">
                  {tasks.map((task) => (
                    <div
                      key={task.id}
                      className={cn(
                        'roadmap-row',
                        selectedId === task.id && 'roadmap-row-selected',
                      )}
                    >
                      <button
                        className="roadmap-task-label"
                        onClick={() => setSelectedId(task.id)}
                        aria-pressed={selectedId === task.id}
                        title={task.title}
                      >
                        {task.isMilestone ? (
                          <Diamond size={14} />
                        ) : (
                          <StatusIcon status={task.status} />
                        )}
                        <span>
                          <small>
                            DEV-{task.number}
                            {warnings.overdue.includes(task.id) ? ' · Overdue' : ''}
                          </small>
                          <strong>{task.title}</strong>
                        </span>
                      </button>
                      <div
                        className="roadmap-track"
                        style={{ width, backgroundSize: `${step * pixels}px 100%` }}
                      >
                        {task.startDate && task.dueDate ? (
                          <ScheduleBar
                            task={task}
                            origin={origin}
                            pixels={pixels}
                            critical={critical && cpm.criticalIds.includes(task.id)}
                            overdue={warnings.overdue.includes(task.id)}
                            disabled={archived || pending}
                            select={() => setSelectedId(task.id)}
                          />
                        ) : (
                          <button
                            className="roadmap-unscheduled"
                            disabled={archived}
                            onClick={() => setSelectedId(task.id)}
                          >
                            <Plus size={12} />{' '}
                            {task.dueDate
                              ? `Due ${dateLabel(utcDay(task.dueDate))} · Set start date`
                              : 'Set schedule'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  <div
                    className="roadmap-overlay"
                    style={{ left: 260, width, height: tasks.length * 54 }}
                    aria-hidden="true"
                  >
                    {todayX >= 0 && todayX <= width && (
                      <div className="roadmap-today" style={{ left: todayX }}>
                        <span>Today</span>
                      </div>
                    )}
                    <svg width={width} height={tasks.length * 54}>
                      <defs>
                        <marker
                          id="roadmap-arrow"
                          viewBox="0 0 10 10"
                          refX="9"
                          refY="5"
                          markerWidth="5"
                          markerHeight="5"
                          orient="auto-start-reverse"
                        >
                          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                        </marker>
                      </defs>
                      {roadmap.dependencies.map((dependency) => {
                        const from = tasks.findIndex((t) => t.id === dependency.predecessorId);
                        const to = tasks.findIndex((t) => t.id === dependency.successorId);
                        const before = tasks[from];
                        const after = tasks[to];
                        if (
                          !before?.dueDate ||
                          !before.startDate ||
                          !after?.startDate ||
                          !after.dueDate
                        )
                          return null;
                        const x1 =
                          (utcDay(before.dueDate) - origin + (before.isMilestone ? 0.5 : 1)) *
                          pixels;
                        const x2 =
                          (utcDay(after.startDate) - origin + (after.isMilestone ? 0.5 : 0)) *
                          pixels;
                        if (x1 < 0 || x1 > width || x2 < 0 || x2 > width) return null;
                        const y1 = from * 54 + 27;
                        const y2 = to * 54 + 27;
                        return (
                          <path
                            key={`${before.id}:${after.id}`}
                            d={`M ${x1} ${y1} C ${x1 + 20} ${y1}, ${x2 - 20} ${y2}, ${x2} ${y2}`}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.5}
                            markerEnd="url(#roadmap-arrow)"
                            className={cn(
                              'roadmap-connector',
                              warnings.conflicts.some(
                                (e) => e.predecessorId === before.id && e.successorId === after.id,
                              ) && 'roadmap-connector-conflict',
                            )}
                          />
                        );
                      })}
                    </svg>
                  </div>
                </div>
              </div>
            </div>
          </DndContext>
        )}
        <div className="roadmap-legend">
          <span>
            <i className="roadmap-legend-critical" />
            Critical task
          </span>
          <span>
            <Diamond size={11} />
            Milestone
          </span>
          <span>
            <i className="roadmap-legend-overdue" />
            Overdue
          </span>
          <span>{tasks.filter((t) => !t.startDate || !t.dueDate).length} unscheduled</span>
        </div>
      </section>
      <div className="roadmap-details-grid">
        <section className="panel roadmap-editor">
          <div className="panel-heading">
            <div>
              <h2>Task schedule</h2>
              <p>Select a task above to plan its delivery.</p>
            </div>
            <CalendarDays size={18} />
          </div>
          {selected ? (
            <ScheduleEditor
              key={`${selected.id}:${selected.version}`}
              task={selected}
              disabled={archived || pending}
              save={(changes) => save.mutate({ task: selected, changes })}
              open={() => openTask(selected.id)}
            />
          ) : (
            <p className="quiet-state">Choose a task to get started.</p>
          )}
        </section>
        <section className="panel roadmap-editor">
          <div className="panel-heading">
            <div>
              <h2>Dependencies</h2>
              <p>Finish-to-start links within this project.</p>
            </div>
            <GitBranch size={18} />
          </div>
          <form
            className="roadmap-dependency-form"
            onSubmit={(e) => {
              e.preventDefault();
              edge.mutate({
                dependency: { projectId: roadmap.project.id, predecessorId, successorId },
              });
            }}
          >
            <label>
              Finish first
              <select
                aria-label="Predecessor task"
                required
                value={predecessorId}
                onChange={(e) => setPredecessor(e.target.value)}
                disabled={archived || pending}
              >
                <option value="">Choose a task</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    DEV-{t.number} · {t.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Then start
              <select
                aria-label="Successor task"
                required
                value={successorId}
                onChange={(e) => setSuccessor(e.target.value)}
                disabled={archived || pending}
              >
                <option value="">Choose a task</option>
                {tasks
                  .filter((t) => t.id !== predecessorId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      DEV-{t.number} · {t.title}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              type="submit"
              size="sm"
              disabled={
                archived ||
                pending ||
                !predecessorId ||
                !successorId ||
                predecessorId === successorId
              }
            >
              <Plus size={13} />
              Add dependency
            </Button>
          </form>
          {edge.isError && (
            <p className="form-error" role="alert">
              {edge.error.message}
            </p>
          )}
          <ul className="roadmap-dependencies">
            {roadmap.dependencies.map((e) => (
              <li key={`${e.predecessorId}:${e.successorId}`}>
                <span>
                  {tasks.find((t) => t.id === e.predecessorId)?.title} <ArrowRight size={12} />{' '}
                  {tasks.find((t) => t.id === e.successorId)?.title}
                </span>
                <button
                  className="icon-button"
                  aria-label={`Remove dependency from ${tasks.find((t) => t.id === e.predecessorId)?.title} to ${tasks.find((t) => t.id === e.successorId)?.title}`}
                  disabled={archived || pending}
                  onClick={() => edge.mutate({ dependency: e, remove: true })}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
          {!roadmap.dependencies.length && (
            <p className="quiet-state">No dependencies yet. Link tasks to make blockers visible.</p>
          )}
        </section>
      </div>
      <section className="roadmap-insights" aria-label="Scheduling insights">
        <div>
          <GitBranch size={17} />
          <div>
            <strong>
              {cpm.complete
                ? `${cpm.duration} calendar-day critical path`
                : 'Critical path needs a complete schedule'}
            </strong>
            <p>
              {cpm.complete
                ? 'Calculated from planned durations and dependencies, including completed tasks. Uses calendar days including weekends; milestones take zero days. Ignores resource constraints and gaps between scheduled dates.'
                : `Set both dates for every task (${cpm.incomplete.length} remaining). Durations will not be guessed.`}
            </p>
          </div>
        </div>
        {warnings.conflicts.length > 0 && (
          <div className="roadmap-warning">
            <AlertTriangle size={17} />
            <div>
              <strong>
                {warnings.conflicts.length} dependency scheduling conflict
                {warnings.conflicts.length === 1 ? '' : 's'}
              </strong>
              <p>
                A successor starts before its predecessor finishes. Adjust dates to leave the
                required finish-to-start interval.
              </p>
              <ul>
                {warnings.conflicts.map((e) => (
                  <li key={`${e.predecessorId}:${e.successorId}`}>
                    {tasks.find((t) => t.id === e.predecessorId)?.title} →{' '}
                    {tasks.find((t) => t.id === e.successorId)?.title}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}

function ScheduleBar({
  task,
  origin,
  pixels,
  critical,
  overdue,
  disabled,
  select,
}: {
  task: Task;
  origin: number;
  pixels: number;
  critical: boolean;
  overdue: boolean;
  disabled: boolean;
  select: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    disabled,
  });
  const left = (utcDay(task.startDate!) - origin) * pixels;
  const width = task.isMilestone
    ? pixels
    : Math.max(pixels, (utcDay(task.dueDate!) - utcDay(task.startDate!) + 1) * pixels);
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'roadmap-bar',
        critical && 'roadmap-bar-critical',
        overdue && 'roadmap-bar-overdue',
        task.status === 'DONE' && 'roadmap-bar-done',
        task.isMilestone && 'roadmap-bar-milestone',
        isDragging && 'roadmap-bar-dragging',
      )}
      style={{ left, width, transform: transform ? `translateX(${transform.x}px)` : undefined }}
    >
      <button
        className="roadmap-bar-grip"
        {...attributes}
        {...listeners}
        aria-label={`Reschedule ${task.title}`}
        disabled={disabled}
        title="Drag to reschedule"
      >
        <GripVertical size={12} />
      </button>
      <button
        className="roadmap-bar-title"
        onClick={select}
        title={`${task.title}: ${task.startDate?.slice(0, 10)} to ${task.dueDate?.slice(0, 10)}`}
      >
        {task.isMilestone ? <Diamond size={15} fill="currentColor" /> : task.title}
      </button>
    </div>
  );
}

function ScheduleEditor({
  task,
  disabled,
  save,
  open,
}: {
  task: Task;
  disabled: boolean;
  save: (changes: Record<string, unknown>) => void;
  open: () => void;
}) {
  const [start, setStart] = useState(task.startDate?.slice(0, 10) ?? '');
  const [due, setDue] = useState(task.dueDate?.slice(0, 10) ?? '');
  const [milestone, setMilestone] = useState(task.isMilestone);
  return (
    <form
      className="roadmap-schedule-form"
      onSubmit={(e) => {
        e.preventDefault();
        save({
          startDate: start ? `${start}T00:00:00.000Z` : null,
          dueDate: due ? `${due}T23:59:59.000Z` : null,
          isMilestone: milestone,
        });
      }}
    >
      <button type="button" className="roadmap-editor-task" onClick={open}>
        DEV-{task.number} · {task.title}
        <ArrowRight size={14} />
      </button>
      <fieldset disabled={disabled}>
        <div className="form-grid">
          <label>
            Start date (UTC)
            <input
              type="date"
              required={milestone}
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                if (milestone) setDue(e.target.value);
              }}
            />
          </label>
          <label>
            Due date (UTC)
            <input
              type="date"
              required={milestone}
              min={start || undefined}
              value={due}
              onChange={(e) => {
                setDue(e.target.value);
                if (milestone) setStart(e.target.value);
              }}
            />
          </label>
        </div>
        <label className="roadmap-milestone-input">
          <input
            type="checkbox"
            checked={milestone}
            onChange={(e) => {
              setMilestone(e.target.checked);
              if (e.target.checked) {
                const date = start || due;
                setStart(date);
                setDue(date);
              }
            }}
          />
          <Diamond size={13} />
          Mark as a milestone
        </label>
        <div className="roadmap-editor-actions">
          <Button type="submit" size="sm">
            Save schedule
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => save({ startDate: null, dueDate: null, isMilestone: false })}
          >
            Clear schedule
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
