'use client';
import { useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  CalendarDays,
  GitFork as Github,
  GripVertical,
  MessageSquare,
  Plus,
  SlidersHorizontal,
} from 'lucide-react';
import type { Snapshot, Status, Task } from '@/lib/types';
import { statuses, statusNames } from '@/lib/types';
import { cn, shortDate } from '@/lib/utils';
import { Avatar, PriorityIcon, StatusIcon } from './common';
import { taskPosition } from '@/lib/kanban';
export function Board({
  tasks,
  data,
  openTask,
  move,
  pending,
  create,
}: {
  tasks: Task[];
  data: Snapshot;
  openTask: (id: string) => void;
  move: (task: Task, changes: Record<string, unknown>) => void;
  pending: boolean;
  create: () => void;
}) {
  const [priority, setPriority] = useState('all');
  const [assignee, setAssignee] = useState('all');
  const [label, setLabel] = useState('all');
  const [sort, setSort] = useState('manual');
  const [active, setActive] = useState<Task | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const filtered = tasks
    .filter(
      (t) =>
        (priority === 'all' || t.priority === priority) &&
        (assignee === 'all' || (assignee === 'none' ? !t.assigneeId : t.assigneeId === assignee)) &&
        (label === 'all' || t.labels.some((l) => l.label.id === label)),
    )
    .sort((a, b) =>
      sort === 'priority'
        ? ['URGENT', 'HIGH', 'MEDIUM', 'LOW'].indexOf(a.priority) -
          ['URGENT', 'HIGH', 'MEDIUM', 'LOW'].indexOf(b.priority)
        : sort === 'due'
          ? (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')
          : a.position - b.position || a.id.localeCompare(b.id),
    );
  const disabled = pending || sort !== 'manual';
  function end(event: DragEndEvent) {
    setActive(null);
    if (!event.over || event.active.id === event.over.id || disabled) return;
    const task = tasks.find((t) => t.id === event.active.id);
    if (!task) return;
    const target = tasks.find((t) => t.id === event.over!.id);
    const status =
      target?.status ??
      (statuses.includes(event.over.id as Status) ? (event.over.id as Status) : null);
    if (!status) return;
    const order = tasks
      .filter((t) => t.status === status && t.id !== task.id)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    let index = target ? order.findIndex((t) => t.id === target.id) : order.length;
    if (target && task.status === status && task.position < target.position) index += 1;
    move(task, { status, position: taskPosition(order, index) });
  }
  return (
    <>
      <div className="filter-row">
        <span>
          <SlidersHorizontal size={14} /> Filter
        </span>
        <select
          aria-label="Filter priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        >
          <option value="all">All priorities</option>
          {['URGENT', 'HIGH', 'MEDIUM', 'LOW'].map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter assignee"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
        >
          <option value="all">All members</option>
          <option value="none">Unassigned</option>
          {data.members.map((m) => (
            <option key={m.user.id} value={m.user.id}>
              {m.user.name}
            </option>
          ))}
        </select>
        <select aria-label="Filter label" value={label} onChange={(e) => setLabel(e.target.value)}>
          <option value="all">All labels</option>
          {data.labels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <span className="filter-spacer" />
        <select aria-label="Sort tasks" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="manual">Manual order</option>
          <option value="priority">By priority</option>
          <option value="due">By due date</option>
        </select>
        <small>{filtered.length} tasks</small>
      </div>
      <p className="board-help">
        {sort === 'manual'
          ? 'Drag to move. Use a card’s grip with Space and arrow keys, or change its status in task details.'
          : 'Switch to manual order to drag tasks.'}
      </p>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={(e) => setActive(tasks.find((t) => t.id === e.active.id) ?? null)}
        onDragCancel={() => setActive(null)}
        onDragEnd={end}
      >
        <div className="kanban-board">
          {statuses.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={filtered.filter((t) => t.status === status)}
              disabled={disabled}
              openTask={openTask}
              create={create}
            />
          ))}
          <DragOverlay>
            {active ? (
              <div className="task-card drag-overlay">
                <TaskCardContent task={active} />
              </div>
            ) : null}
          </DragOverlay>
        </div>
      </DndContext>
    </>
  );
}
function Column({
  status,
  tasks,
  disabled,
  openTask,
  create,
}: {
  status: Status;
  tasks: Task[];
  disabled: boolean;
  openTask: (id: string) => void;
  create: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status, disabled });
  return (
    <section
      ref={setNodeRef}
      className={cn('kanban-column', isOver && 'column-over')}
      aria-label={statusNames[status]}
    >
      <header>
        <StatusIcon status={status} />
        <h2>{statusNames[status]}</h2>
        <span>{tasks.length}</span>
        <button
          aria-label={`Add task from ${statusNames[status]}`}
          className="icon-button"
          onClick={create}
        >
          <Plus size={15} />
        </button>
      </header>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        {tasks.map((task) => (
          <SortableTask key={task.id} task={task} disabled={disabled} openTask={openTask} />
        ))}
      </SortableContext>
      {!tasks.length && <div className="column-empty">A little room for what’s next.</div>}
      <button className="add-board-task" onClick={create}>
        <Plus size={14} /> Add task
      </button>
    </section>
  );
}
function SortableTask({
  task,
  disabled,
  openTask,
}: {
  task: Task;
  disabled: boolean;
  openTask: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled,
  });
  return (
    <article
      ref={setNodeRef}
      className={cn('task-card', isDragging && 'task-dragging')}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="task-card-actions">
        <span className="task-number">DEV–{String(task.number).padStart(3, '0')}</span>
        <button
          className="drag-grip"
          aria-label={`Move ${task.title}`}
          {...attributes}
          {...listeners}
          disabled={disabled}
        >
          <GripVertical size={14} />
        </button>
      </div>
      <button className="task-open" onClick={() => openTask(task.id)}>
        <TaskCardContent task={task} hideNumber />
      </button>
    </article>
  );
}
function TaskCardContent({ task, hideNumber = false }: { task: Task; hideNumber?: boolean }) {
  const late = task.status !== 'DONE' && task.dueDate && new Date(task.dueDate) < new Date();
  return (
    <>
      {!hideNumber && (
        <span className="task-number">DEV–{String(task.number).padStart(3, '0')}</span>
      )}
      <h3>{task.title}</h3>
      <div className="task-tags">
        {task.labels.map((l) => (
          <span
            className="tag"
            key={l.label.id}
            style={{
              color: 'var(--text)',
              background: `${l.label.color}13`,
              borderInlineStart: `2px solid ${l.label.color}`,
            }}
          >
            {l.label.name}
          </span>
        ))}
      </div>
      <div className="task-card-footer">
        <PriorityIcon priority={task.priority} />
        {task.dueDate && (
          <span className={cn('task-date', late && 'overdue')}>
            <CalendarDays size={11} />
            {shortDate(task.dueDate)}
          </span>
        )}
        {task._count.comments > 0 && (
          <span className="task-date">
            <MessageSquare size={11} />
            {task._count.comments}
          </span>
        )}
        {!!task._count.githubLinks && (
          <span
            role="img"
            className="task-date task-github-indicator"
            title={`${task._count.githubLinks} linked GitHub ${task._count.githubLinks === 1 ? 'object' : 'objects'}`}
            aria-label={`GitHub activity: ${task._count.githubLinks} linked ${task._count.githubLinks === 1 ? 'object' : 'objects'}`}
          >
            <Github size={12} aria-hidden="true" />
            {task._count.githubLinks}
          </span>
        )}
        <span className="flex-spacer" />
        {task.assignee ? (
          <Avatar person={task.assignee} size="small" />
        ) : (
          <span className="unassigned-avatar">?</span>
        )}
      </div>
    </>
  );
}
