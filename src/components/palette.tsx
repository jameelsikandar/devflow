'use client';
import { useState } from 'react';
import {
  Command,
  Folder,
  GitBranch,
  LayoutDashboard,
  Moon,
  Plus,
  Search,
  Settings2,
  Sun,
} from 'lucide-react';
import { Dialog } from './ui/dialog';
import type { Snapshot } from '@/lib/types';
import { usePreferences, type View } from '@/lib/client';
export function CommandPalette({
  open,
  setOpen,
  data,
  navigate,
  openTask,
  openProject,
  createTask,
  createProject,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  data?: Snapshot;
  navigate: (v: View) => void;
  openTask: (id: string) => void;
  openProject: (id: string) => void;
  createTask: () => void;
  createProject: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const { theme, setTheme } = usePreferences();
  const commands = [
    {
      id: 'roadmap',
      label: 'Open project roadmap',
      section: 'Navigate',
      icon: GitBranch,
      run: () => navigate('roadmap'),
    },
    {
      id: 'overview',
      label: 'Go to overview',
      section: 'Navigate',
      icon: LayoutDashboard,
      run: () => navigate('overview'),
    },
    { id: 'task', label: 'Create new task', section: 'Actions', icon: Plus, run: createTask },
    {
      id: 'project',
      label: 'Create new project',
      section: 'Actions',
      icon: Folder,
      run: createProject,
    },
    {
      id: 'settings',
      label: 'Open settings & members',
      section: 'Navigate',
      icon: Settings2,
      run: () => navigate('settings'),
    },
    {
      id: 'theme',
      label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`,
      section: 'Actions',
      icon: theme === 'dark' ? Sun : Moon,
      run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    },
    ...(data?.projects
      .filter((p) => !p.archivedAt)
      .map((p) => ({
        id: p.id,
        label: p.name,
        section: 'Projects',
        icon: Folder,
        run: () => openProject(p.id),
      })) ?? []),
    ...(data?.tasks
      .filter((t) => !data.projects.find((p) => p.id === t.projectId)?.archivedAt)
      .map((t) => ({
        id: t.id,
        label: `DEV–${t.number} ${t.title}`,
        section: 'Tasks',
        icon: Command,
        run: () => openTask(t.id),
      })) ?? []),
  ]
    .filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 30);
  const execute = (i: number) => {
    const command = commands[i];
    if (command) {
      setOpen(false);
      command.run();
      setQuery('');
      setIndex(0);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setQuery('');
          setIndex(0);
        }
      }}
      title="Find your next move"
      description="Search your workspace or jump to an action."
    >
      <div className="command-search">
        <Search size={18} />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls="command-results"
          aria-autocomplete="list"
          aria-activedescendant={commands[index] ? `command-${commands[index].id}` : undefined}
          aria-label="Search commands, projects, and tasks"
          placeholder="Where would you like to go?"
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(commands.length - 1, i + 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              execute(index);
            }
          }}
        />
        <kbd>esc</kbd>
      </div>
      <div role="listbox" id="command-results" className="command-results" aria-label="Commands">
        {commands.map((c, i) => (
          <div
            role="option"
            aria-selected={index === i}
            id={`command-${c.id}`}
            key={c.id}
            className={`command-option ${index === i ? 'selected' : ''}`}
            onMouseMove={() => setIndex(i)}
            onClick={() => execute(i)}
          >
            <c.icon size={16} />
            <span>{c.label}</span>
            <small>{c.section}</small>
            {index === i && <kbd>↵</kbd>}
          </div>
        ))}
        {!commands.length && (
          <p className="quiet-state">No matches. Try a task title or project name.</p>
        )}
      </div>
      <div className="command-footer">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> to navigate
        </span>
        <span>
          <kbd>↵</kbd> to open
        </span>
        <span>
          <Command size={12} /> K to toggle
        </span>
      </div>
    </Dialog>
  );
}
