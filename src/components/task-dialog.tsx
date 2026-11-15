'use client';
import { useEffect, useState } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { Check, Loader2, MessageSquare, Plus, Send, Trash2 } from 'lucide-react';
import { api, body, useToasts } from '@/lib/client';
import { projectSchema, taskSchema } from '@/lib/validation';
import type { Snapshot, TaskDetail } from '@/lib/types';
import { priorities, statuses, statusNames } from '@/lib/types';
import { relativeDate } from '@/lib/utils';
import { Avatar, Skeleton } from './common';
import { Dialog } from './ui/dialog';
import { Button } from './ui/button';
import { TaskGitHubActivity } from './task-github-activity';
type Scope = (v: string) => string;
type TaskValues = z.infer<typeof taskSchema>;
export function CreateProject({
  open,
  onOpenChange,
  scope,
  refresh,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  scope: Scope;
  refresh: () => Promise<void>;
}) {
  const toast = useToasts((s) => s.add);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof projectSchema>>({
    resolver: zodResolver(projectSchema),
    defaultValues: { name: '', description: '', color: '#a78bfa' },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Every great idea starts somewhere"
      description="Give your project a name and a little direction."
    >
      <form
        className="dialog-form"
        onSubmit={handleSubmit(async (values) => {
          try {
            await api(scope('projects'), { method: 'POST', body: body(values) });
            await refresh();
            reset();
            onOpenChange(false);
            toast('Project created. Make something great.');
          } catch (e) {
            toast((e as Error).message, true);
          }
        })}
      >
        <label>
          Project name
          <input placeholder="e.g. Platform redesign" autoFocus {...register('name')} />
          {errors.name && <span className="field-error">{errors.name.message}</span>}
        </label>
        <label>
          Description
          <textarea
            placeholder="What are we building, and why?"
            rows={3}
            {...register('description')}
          />
          {errors.description && <span className="field-error">{errors.description.message}</span>}
        </label>
        <label>
          Project color
          <input type="color" className="color-picker" {...register('color')} />
        </label>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}Create project
        </Button>
      </form>
    </Dialog>
  );
}
export function CreateTask({
  open,
  onOpenChange,
  data,
  projectId,
  scope,
  refresh,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  data: Snapshot;
  projectId: string;
  scope: Scope;
  refresh: () => Promise<void>;
}) {
  const toast = useToasts((s) => s.add);
  const active = data.projects.filter((p) => !p.archivedAt);
  const defaults = {
    title: '',
    description: '',
    projectId: active.some((p) => p.id === projectId) ? projectId : (active[0]?.id ?? ''),
    status: 'TODO' as const,
    priority: 'MEDIUM' as const,
    labelIds: [],
  };
  const form = useForm<TaskValues>({ resolver: zodResolver(taskSchema), defaultValues: defaults });
  useEffect(() => {
    if (open)
      form.reset({
        ...defaults,
        projectId: active.some((p) => p.id === projectId) ? projectId : (active[0]?.id ?? ''),
      });
    // Form resets only when opened or the selected project changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Make your next move"
      description="Capture the work. Give it a clear next step."
    >
      {!active.length ? (
        <div className="dialog-form">
          <p>Create a project first, then add your tasks from its board.</p>
        </div>
      ) : (
        <form
          className="dialog-form"
          onSubmit={form.handleSubmit(async (values) => {
            try {
              await api(scope('tasks'), { method: 'POST', body: body(values) });
              await refresh();
              onOpenChange(false);
              form.reset();
              toast('Task created');
            } catch (e) {
              toast((e as Error).message, true);
            }
          })}
        >
          <TaskFields form={form} data={data} includeProject />
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <Plus size={16} />
            )}
            Create task <kbd>C</kbd>
          </Button>
        </form>
      )}
    </Dialog>
  );
}
function TaskFields({
  form,
  data,
  includeProject = false,
}: {
  form: UseFormReturn<TaskValues>;
  data: Snapshot;
  includeProject?: boolean;
}) {
  const {
    register,
    formState: { errors },
    watch,
    setValue,
  } = form;
  const labels = watch('labelIds') ?? [];
  return (
    <>
      <label>
        Title
        <input autoFocus placeholder="What needs to happen?" {...register('title')} />
        {errors.title && <span className="field-error">{errors.title.message}</span>}
      </label>
      <label>
        Description
        <textarea
          rows={4}
          placeholder="Add context, requirements, or acceptance criteria..."
          {...register('description')}
        />
        {errors.description && <span className="field-error">{errors.description.message}</span>}
      </label>
      {includeProject && (
        <label>
          Project
          <select {...register('projectId')}>
            {data.projects
              .filter((p) => !p.archivedAt)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          {errors.projectId && <span className="field-error">Choose a project</span>}
        </label>
      )}
      <div className="form-grid">
        <label>
          Status
          <select {...register('status')}>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {statusNames[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select {...register('priority')}>
            {priorities.map((p) => (
              <option key={p} value={p}>
                {p[0] + p.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <label>
          Assignee
          <select
            value={watch('assigneeId') ?? ''}
            onChange={(e) => setValue('assigneeId', e.target.value || null)}
          >
            <option value="">Unassigned</option>
            {data.members.map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Start date
          <input
            type="date"
            value={watch('startDate')?.slice(0, 10) ?? ''}
            onChange={(e) =>
              setValue('startDate', e.target.value ? `${e.target.value}T00:00:00.000Z` : null)
            }
          />
        </label>
        <label>
          Due date
          <input
            type="date"
            value={watch('dueDate')?.slice(0, 10) ?? ''}
            onChange={(e) =>
              setValue('dueDate', e.target.value ? `${e.target.value}T23:59:59.000Z` : null)
            }
          />
        </label>
      </div>
      <fieldset className="label-picker">
        <legend>Labels</legend>
        <div>
          {data.labels.map((l) => (
            <button
              className={`label-option ${labels.includes(l.id) ? 'label-selected' : ''}`}
              type="button"
              key={l.id}
              aria-pressed={labels.includes(l.id)}
              onClick={() =>
                setValue(
                  'labelIds',
                  labels.includes(l.id) ? labels.filter((id) => id !== l.id) : [...labels, l.id],
                )
              }
            >
              <span className="project-dot" style={{ background: l.color }} />
              {l.name}
              {labels.includes(l.id) && <Check size={12} />}
            </button>
          ))}
        </div>
      </fieldset>
    </>
  );
}
export function TaskDialog({
  id,
  onClose,
  data,
  scope,
  refresh,
}: {
  id: string | null;
  onClose: () => void;
  data: Snapshot;
  scope: Scope;
  refresh: () => Promise<void>;
}) {
  const detail = useQuery({
    queryKey: ['task', id, data.workspace.id],
    queryFn: () => api<TaskDetail>(scope(`tasks/${id}`)),
    enabled: !!id,
  });
  return (
    <Dialog
      open={!!id}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={detail.data ? `DEV–${String(detail.data.number).padStart(3, '0')}` : 'Task details'}
      description={
        detail.data
          ? data.projects.find((p) => p.id === detail.data?.projectId)?.name
          : 'Loading task details'
      }
      wide
    >
      {detail.isError ? (
        <p className="dialog-form form-error">{detail.error.message}</p>
      ) : detail.data ? (
        <EditTask
          key={id}
          task={detail.data}
          data={data}
          scope={scope}
          refresh={refresh}
          onClose={onClose}
          refetch={async () => {
            await detail.refetch();
          }}
        />
      ) : (
        <div className="dialog-form">
          <Skeleton />
        </div>
      )}
    </Dialog>
  );
}
function EditTask({
  task,
  data,
  scope,
  refresh,
  onClose,
  refetch,
}: {
  task: TaskDetail;
  data: Snapshot;
  scope: Scope;
  refresh: () => Promise<void>;
  onClose: () => void;
  refetch: () => Promise<void>;
}) {
  const toast = useToasts((s) => s.add);
  const [version, setVersion] = useState(task.version);
  const [comment, setComment] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<'comments' | 'activity'>('comments');
  const form = useForm<TaskValues>({
    resolver: zodResolver(taskSchema),
    defaultValues: { ...task, labelIds: task.labels.map((l) => l.label.id) },
  });
  const archived = !!data.projects.find((p) => p.id === task.projectId)?.archivedAt;
  const save = useMutation({
    mutationFn: (values: TaskValues) => {
      const rest = {
        title: values.title,
        description: values.description,
        status: values.status,
        priority: values.priority,
        assigneeId: values.assigneeId,
        startDate: values.startDate,
        dueDate: values.dueDate,
        labelIds: values.labelIds,
      };
      return api<TaskDetail>(scope(`tasks/${task.id}`), {
        method: 'PATCH',
        body: body({ ...rest, version }),
      });
    },
    onSuccess: async (result) => {
      setVersion(result.version);
      await refresh();
      toast('Changes saved');
    },
    onError: (e) => toast(e.message, true),
  });
  const addComment = useMutation({
    mutationFn: () =>
      api(scope(`tasks/${task.id}/comments`), { method: 'POST', body: body({ body: comment }) }),
    onSuccess: async () => {
      setComment('');
      await refresh();
      await refetch();
      toast('Comment added');
    },
    onError: (e) => toast(e.message, true),
  });
  const remove = useMutation({
    mutationFn: () => api(scope(`tasks/${task.id}`), { method: 'DELETE' }),
    onSuccess: async () => {
      await refresh();
      onClose();
      toast('Task deleted');
    },
    onError: (e) => toast(e.message, true),
  });
  return (
    <div className="task-detail-body">
      {task.parentTask && (
        <p className="notice">
          Subtask of DEV-{task.parentTask.number} · {task.parentTask.title}
        </p>
      )}
      <form
        className="dialog-form task-edit-form"
        onSubmit={form.handleSubmit((values) => save.mutate(values))}
      >
        {archived && (
          <p className="notice">
            This project is archived. Restore it from Projects to edit tasks.
          </p>
        )}
        {version !== task.version && (
          <p className="notice">
            This task has changed since you opened it.{' '}
            <button
              type="button"
              onClick={() => {
                form.reset({ ...task, labelIds: task.labels.map((l) => l.label.id) });
                setVersion(task.version);
              }}
            >
              Load latest version
            </button>
          </p>
        )}
        <fieldset disabled={archived || save.isPending}>
          <TaskFields form={form} data={data} />
        </fieldset>
        <div className="form-footer">
          <button
            type="button"
            disabled={archived}
            className="text-danger"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={14} />
            Delete task
          </button>
          <Button type="submit" disabled={save.isPending || archived}>
            {save.isPending ? <Loader2 className="spin" size={15} /> : <Check size={15} />}Save
            changes
          </Button>
        </div>
        {confirmDelete && (
          <div className="delete-confirm" role="alert">
            <p>Permanently delete this task and its comments?</p>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Delete permanently
            </Button>
            <Button variant="ghost" type="button" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        )}
      </form>
      <section className="task-discussion">
        {!!task.subtasks?.length && (
          <div className="notice">
            <strong>Subtasks</strong>
            <ul>
              {task.subtasks.map((child) => (
                <li key={child.id}>
                  DEV-{child.number} · {child.title} — {statusNames[child.status]}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="segmented">
          <button
            className={tab === 'comments' ? 'selected' : ''}
            onClick={() => setTab('comments')}
          >
            <MessageSquare size={14} />
            Comments ({task.comments.length})
          </button>
          <button
            className={tab === 'activity' ? 'selected' : ''}
            onClick={() => setTab('activity')}
          >
            Activity
          </button>
        </div>
        {tab === 'comments' ? (
          <>
            <div className="comments">
              {task.comments.length ? (
                task.comments.map((c) => (
                  <div className="comment" key={c.id}>
                    <Avatar person={c.author} size="small" />
                    <div>
                      <strong>{c.author.name}</strong>
                      <time>{relativeDate(c.createdAt)}</time>
                      <p>{c.body}</p>
                    </div>
                  </div>
                ))
              ) : (
                <p className="discussion-empty">
                  Good conversations move work forward.
                  <br />
                  Start one here.
                </p>
              )}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (comment.trim()) addComment.mutate();
              }}
            >
              <label className="sr-only" htmlFor="comment-body">
                Write a comment
              </label>
              <textarea
                id="comment-body"
                placeholder="Share a thought or an update..."
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                maxLength={10000}
                disabled={archived}
              />
              <Button
                type="submit"
                size="sm"
                disabled={archived || !comment.trim() || addComment.isPending}
              >
                <Send size={13} />
                Comment
              </Button>
            </form>
          </>
        ) : (
          <div className="task-history">
            {task.activities.map((a) => (
              <p key={a.id}>
                <span className="history-dot" />
                <span>
                  <strong>
                    {a.source === 'GITHUB_AUTOMATION'
                      ? 'GitHub automation'
                      : (a.actor?.name ?? 'Former member')}
                  </strong>{' '}
                  {a.message}
                  <small>{relativeDate(a.createdAt)}</small>
                </span>
              </p>
            ))}
          </div>
        )}
      </section>
      <TaskGitHubActivity
        key={`${data.workspace.id}:${task.id}`}
        taskId={task.id}
        projectId={task.projectId}
        workspaceId={data.workspace.id}
        scope={scope}
      />
    </div>
  );
}
