// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { Roadmap } from '../src/components/roadmap';
import { dependencySchema } from '../src/lib/roadmap';
import type { RoadmapData, Snapshot } from '../src/lib/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('removes a loaded dependency with metadata using the strict command payload and refreshes the list', async () => {
  const edge = {
    projectId: 'project',
    predecessorId: 'first',
    successorId: 'next',
    createdAt: '2026-11-01T00:00:00.000Z',
  };
  const roadmap = {
    project: { id: 'project', name: 'Launch', archivedAt: null },
    tasks: ['first', 'next'].map((id, i) => ({
      id,
      number: i + 1,
      projectId: 'project',
      title: i ? 'Next release' : 'First release',
      status: 'TODO',
      priority: 'MEDIUM',
      startDate: null,
      dueDate: null,
      isMilestone: false,
      version: 0,
      labels: [],
      assignee: null,
    })),
    dependencies: [edge],
  } as unknown as RoadmapData;
  const data = { workspace: { id: 'workspace' }, projects: [roadmap.project] } as Snapshot;
  const deletes: unknown[] = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      const command: unknown = JSON.parse(String(init.body));
      deletes.push(command);
      // Emulate the real API's strict contract, not a permissive success fixture.
      const parsed = dependencySchema.safeParse(command);
      if (!parsed.success)
        return new Response(JSON.stringify({ error: parsed.error.message }), { status: 400 });
      roadmap.dependencies = [];
      return new Response(JSON.stringify({ ok: true, changed: true }));
    }
    return new Response(JSON.stringify(roadmap));
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const refresh = vi.fn(() => client.invalidateQueries({ queryKey: ['roadmap'] }));
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  try {
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(Roadmap, {
            data,
            projectId: 'project',
            setProject: vi.fn(),
            openTask: vi.fn(),
            scope: (route) => `${route}?workspaceId=workspace`,
            refresh,
            createProject: vi.fn(),
          }),
        ),
      ),
    );
    await act(async () => {
      await vi.waitFor(() =>
        expect(el.querySelectorAll('.roadmap-dependencies li')).toHaveLength(1),
      );
    });
    const remove = el.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove dependency from First release to Next release"]',
    )!;
    expect(remove).not.toBeNull();
    await act(async () => remove.click());
    await act(async () => {
      await vi.waitFor(() =>
        expect(el.querySelectorAll('.roadmap-dependencies li')).toHaveLength(0),
      );
    });
    expect(deletes).toEqual([
      { projectId: 'project', predecessorId: 'first', successorId: 'next' },
    ]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(el.textContent).toContain('No dependencies yet.');
    expect(el.querySelector('.roadmap-editor [role="alert"]')).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    el.remove();
    vi.unstubAllGlobals();
  }
});
