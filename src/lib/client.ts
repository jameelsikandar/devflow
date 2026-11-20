'use client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
export type View =
  | 'overview'
  | 'projects'
  | 'documents'
  | 'board'
  | 'roadmap'
  | 'my-tasks'
  | 'analytics'
  | 'activity'
  | 'github'
  | 'assistant'
  | 'settings';
export const usePreferences = create<{
  theme: 'dark' | 'light';
  workspaceId: string;
  setTheme: (v: 'dark' | 'light') => void;
  setWorkspace: (id: string) => void;
}>()(
  persist(
    (set) => ({
      theme: 'dark',
      workspaceId: '',
      setTheme: (theme) => set({ theme }),
      setWorkspace: (workspaceId) => set({ workspaceId }),
    }),
    { name: 'devflow-preferences' },
  ),
);
export const useToasts = create<{
  items: { id: number; message: string; error: boolean }[];
  add: (message: string, error?: boolean) => void;
  remove: (id: number) => void;
}>((set) => ({
  items: [],
  add: (message, error = false) => {
    const id = Date.now() + Math.random();
    set((s) => ({ items: [...s.items, { id, message, error }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((t) => t.id !== id) })), 5000);
  },
  remove: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    ...options,
    headers: {
      ...(options?.body && typeof options.body === 'string'
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...options?.headers,
    },
  });
  const data = await response
    .json()
    .catch(() => ({ error: 'The server returned an invalid response' }));
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined' && !path.startsWith('auth/'))
      window.location.assign('/login');
    throw new ApiError(data.error ?? 'Request failed', response.status);
  }
  return data as T;
}
export const body = (value: unknown) => JSON.stringify(value);
