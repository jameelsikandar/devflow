'use client';
import {
  Check,
  X,
  AlertCircle,
  Circle,
  CircleDashed,
  CircleDot,
  CheckCircle2,
  Timer,
  ArrowUp,
  Minus,
  SignalHigh,
  SignalLow,
} from 'lucide-react';
import { cn, initials } from '@/lib/utils';
import type { Person, Priority, Status } from '@/lib/types';
import { statusNames } from '@/lib/types';
import { useToasts } from '@/lib/client';
export function Avatar({
  person,
  size = 'normal',
}: {
  person: Person;
  size?: 'small' | 'normal' | 'large';
}) {
  return (
    <span className={cn('avatar', `avatar-${size}`)} title={person.name}>
      {person.hasAvatar || person.avatarType ? (
        <span
          style={{
            backgroundImage: `url(/api/avatar/${person.id}?v=${encodeURIComponent(
              person.updatedAt ?? '',
            )})`,
          }}
          className="avatar-image"
        />
      ) : (
        initials(person.name)
      )}
    </span>
  );
}
export function StatusIcon({ status }: { status: Status }) {
  const Icon = {
    BACKLOG: CircleDashed,
    TODO: Circle,
    IN_PROGRESS: CircleDot,
    IN_REVIEW: Timer,
    DONE: CheckCircle2,
  }[status];
  return <Icon size={15} className={`status-${status}`} aria-label={statusNames[status]} />;
}
export function PriorityIcon({ priority }: { priority: Priority }) {
  const Icon = { URGENT: AlertCircle, HIGH: SignalHigh, MEDIUM: Minus, LOW: SignalLow }[priority];
  return (
    <Icon
      size={15}
      className={`priority-${priority}`}
      aria-label={`${priority.toLowerCase()} priority`}
    />
  );
}
export function Toasts() {
  const { items, remove } = useToasts();
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {items.map((t) => (
        <div
          key={t.id}
          className={cn('toast', t.error && 'toast-error')}
          role={t.error ? 'alert' : 'status'}
        >
          {t.error ? <AlertCircle size={17} /> : <Check size={17} />}
          <span>{t.message}</span>
          <button onClick={() => remove(t.id)} aria-label="Dismiss notification">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <ArrowUp size={22} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Skeleton() {
  return (
    <div className="skeleton-page" aria-label="Loading workspace" role="status">
      <div className="skeleton skeleton-heading" />
      <div className="stat-grid">
        {[1, 2, 3, 4].map((n) => (
          <div key={n} className="skeleton skeleton-stat" />
        ))}
      </div>
      <div className="skeleton skeleton-chart" />
      <div className="skeleton skeleton-chart" />
    </div>
  );
}
