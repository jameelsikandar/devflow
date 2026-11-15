export const statuses = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const;
export type Status = (typeof statuses)[number];
export const priorities = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type Priority = (typeof priorities)[number];
export const statusNames: Record<Status, string> = {
  BACKLOG: 'Backlog',
  TODO: 'Todo',
  IN_PROGRESS: 'In progress',
  IN_REVIEW: 'In review',
  DONE: 'Done',
};
export interface Person {
  id: string;
  name: string;
  email: string;
  hasAvatar?: boolean;
  avatarType?: string | null;
  updatedAt?: string;
}
export interface Label {
  id: string;
  name: string;
  color: string;
}
export interface Task {
  id: string;
  number: number;
  projectId: string;
  parentTaskId?: string | null;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  assigneeId: string | null;
  assignee: Person | null;
  startDate: string | null;
  dueDate: string | null;
  isMilestone: boolean;
  position: number;
  version: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  labels: { label: Label }[];
  _count: { comments: number; githubLinks?: number };
}
export interface RoadmapData {
  project: Project;
  tasks: Task[];
  dependencies: import('./roadmap').Dependency[];
}
export interface Project {
  id: string;
  name: string;
  description: string;
  color: string;
  repository: string | null;
  archivedAt: string | null;
  _count: { tasks: number };
}
export interface Activity {
  id: string;
  taskId: string | null;
  message: string;
  createdAt: string;
  actor: Person | null;
  source?: 'HUMAN' | 'GITHUB_AUTOMATION';
}
export interface Member {
  user: Person;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  lastSeenAt: string;
}
export interface Workspace {
  id: string;
  name: string;
  role: Member['role'];
}
export interface Snapshot {
  workspace: Workspace;
  workspaces: Workspace[];
  projects: Project[];
  tasks: Task[];
  members: Member[];
  labels: Label[];
  activity: Activity[];
  notifications: { id: string; message: string; readAt: string | null }[];
}
export interface TaskDetail extends Task {
  parentTask?: Pick<Task, 'id' | 'number' | 'title'> | null;
  subtasks?: Pick<Task, 'id' | 'number' | 'title' | 'status'>[];
  comments: { id: string; body: string; createdAt: string; author: Person }[];
  activities: Activity[];
}
export interface GitHubData {
  configured: boolean;
  connected: boolean;
  demo?: boolean;
  login?: string;
  repositories: {
    id: number;
    full_name: string;
    description: string | null;
    html_url: string;
    language: string | null;
    stargazers_count: number;
    private: boolean;
  }[];
  commits?: {
    sha: string;
    html_url: string;
    commit: { message: string; author: { name: string; date: string } };
  }[];
  pulls?: {
    id: number;
    number: number;
    title: string;
    html_url: string;
    user: { login: string };
  }[];
}
