'use client';
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Plus, Archive, Pencil } from 'lucide-react';
import { api, body, useToasts } from '@/lib/client';
import type { Snapshot } from '@/lib/types';
import type { DocumentPage, ProjectDocumentView } from '@/lib/documents';
import { Empty, Skeleton } from './common';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import './project-documents.css';
export function ProjectDocuments({
  data,
  selectedProjectId,
  onProjectChange,
}: {
  data: Snapshot;
  selectedProjectId: string;
  onProjectChange: (id: string) => void;
}) {
  const projects = data.projects;
  const projectId = projects.some((p) => p.id === selectedProjectId)
    ? selectedProjectId
    : (projects.find((p) => !p.archivedAt)?.id ?? projects[0]?.id);
  if (!projectId)
    return (
      <Empty
        title="Create a project first"
        description="Documents belong to a project and its workspace."
      />
    );
  return (
    <DocumentWorkspace
      key={`${data.workspace.id}:${projectId}`}
      data={data}
      projectId={projectId}
      onProjectChange={onProjectChange}
    />
  );
}
function DocumentWorkspace({
  data,
  projectId,
  onProjectChange,
}: {
  data: Snapshot;
  projectId: string;
  onProjectChange: (id: string) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [archived, setArchived] = useState(false);
  const [create, setCreate] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const client = useQueryClient();
  const base = `projects/${encodeURIComponent(projectId)}/documents`;
  const scope = (path: string) => `${path}?workspaceId=${encodeURIComponent(data.workspace.id)}`;
  const queryKey = ['project-documents', data.workspace.id, projectId];
  const page = useQuery({
    queryKey: [...queryKey, offset, archived],
    queryFn: () =>
      api<DocumentPage>(`${scope(base)}&offset=${offset}&archived=${archived}`, {
        cache: 'no-store',
      }),
    retry: false,
  });
  const refresh = async () => {
    await client.invalidateQueries({ queryKey });
  };
  const project = data.projects.find((p) => p.id === projectId)!;
  return (
    <section className="project-documents" aria-label="Project documents">
      <div className="document-toolbar">
        <label>
          Project
          <select
            aria-label="Document project"
            value={projectId}
            onChange={(e) => onProjectChange(e.target.value)}
          >
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.archivedAt ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Show
          <select
            aria-label="Document state"
            value={archived ? 'archived' : 'active'}
            onChange={(e) => {
              setArchived(e.target.value === 'archived');
              setOffset(0);
            }}
          >
            <option value="active">Active documents</option>
            <option value="archived">Archived documents</option>
          </select>
        </label>
        <Button disabled={!!project.archivedAt} onClick={() => setCreate(true)}>
          <Plus size={16} />
          New document
        </Button>
      </div>
      <p className="document-note">
        Documents are private to their owner and workspace administrators until access is granted.
        This milestone manages titles, summaries and permissions; content editing follows in M4.2.
      </p>
      {project.archivedAt && (
        <p role="status">This project is archived. Documents are read-only.</p>
      )}
      {page.isPending ? (
        <div role="status" aria-label="Loading documents">
          <Skeleton />
        </div>
      ) : page.isError ? (
        <div role="alert">
          <p>{page.error.message}</p>
          <Button variant="outline" onClick={() => page.refetch()}>
            Retry documents
          </Button>
        </div>
      ) : (
        <>
          {!page.data.documents.length ? (
            <Empty
              title={archived ? 'No archived documents' : 'No documents you can access'}
              description={
                archived
                  ? 'Archived documents are retained here.'
                  : 'Create a document or ask its owner to grant you access.'
              }
            />
          ) : (
            <ul className="document-list">
              {page.data.documents.map((d) => (
                <li key={d.id}>
                  <button className="document-card" onClick={() => setSelected(d.id)}>
                    <FileText size={19} aria-hidden="true" />
                    <span>
                      <strong>{d.title}</strong>
                      <span>{d.summary || 'No summary yet'}</span>
                      <small>
                        {d.owner.name} · {new Date(d.updatedAt).toLocaleDateString()}
                        {d.archivedAt ? ' · Archived' : ''}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="document-pagination">
            <span>
              {page.data.total} accessible {page.data.total === 1 ? 'document' : 'documents'}
            </span>
            <Button
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={!page.data.hasMore}
              onClick={() => setOffset(offset + 25)}
            >
              Next
            </Button>
          </div>
        </>
      )}
      {create && (
        <DocumentForm
          title="New document"
          endpoint={scope(base)}
          onClose={() => setCreate(false)}
          onSaved={async (d) => {
            setCreate(false);
            await refresh();
            setSelected(d.id);
          }}
        />
      )}
      {selected && (
        <DocumentDetail
          key={selected}
          id={selected}
          data={data}
          base={base}
          scope={scope}
          onClose={() => setSelected(null)}
          refresh={refresh}
        />
      )}
    </section>
  );
}
function DocumentForm({
  title,
  endpoint,
  initial,
  onClose,
  onSaved,
}: {
  title: string;
  endpoint: string;
  initial?: ProjectDocumentView;
  onClose: () => void;
  onSaved: (d: ProjectDocumentView) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.title ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const save = useMutation({
    mutationFn: () =>
      api<ProjectDocumentView>(endpoint, {
        method: initial ? 'PATCH' : 'POST',
        body: body({ title: name, summary, ...(initial ? { version: initial.version } : {}) }),
      }),
    onSuccess: onSaved,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!save.isPending) save.mutate();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
      title={title}
      description="Manage the document title and summary. Document content editing is deferred to M4.2."
    >
      <form className="document-form" onSubmit={submit}>
        <label>
          Title
          <input
            autoFocus
            required
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Summary
          <textarea
            maxLength={2000}
            rows={4}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>
        {save.isError && (
          <p role="alert">
            {save.error.message}{' '}
            {initial && 'Close and reopen the document to load its current version.'}
          </p>
        )}
        <div className="document-actions">
          <Button type="button" variant="ghost" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending || !name.trim()}>
            {save.isPending ? 'Saving…' : 'Save document'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function DocumentDetail({
  id,
  data,
  base,
  scope,
  onClose,
  refresh,
}: {
  id: string;
  data: Snapshot;
  base: string;
  scope: (path: string) => string;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const client = useQueryClient();
  const toast = useToasts((s) => s.add);
  const key = ['project-document', data.workspace.id, base, id];
  const doc = useQuery({
    queryKey: key,
    queryFn: () =>
      api<ProjectDocumentView & { projectArchived: boolean }>(scope(`${base}/${id}`), {
        cache: 'no-store',
      }),
    retry: false,
  });
  const [edit, setEdit] = useState(false);
  const [archive, setArchive] = useState(false);
  const [target, setTarget] = useState('');
  const [access, setAccess] = useState<'READER' | 'EDITOR'>('READER');
  const invalidate = async () => {
    await client.invalidateQueries({ queryKey: key });
    await refresh();
  };
  const change = useMutation({
    mutationFn: ({ action, userId }: { action: 'archive' | 'grant' | 'revoke'; userId?: string }) =>
      api(
        scope(
          `${base}/${id}/${action === 'archive' ? 'archive' : `grants/${encodeURIComponent(userId!)}`}`,
        ),
        {
          method: action === 'archive' ? 'POST' : action === 'grant' ? 'PUT' : 'DELETE',
          body: body({ version: doc.data!.version, ...(action === 'grant' ? { access } : {}) }),
        },
      ),
    onSuccess: async (_, command) => {
      await invalidate();
      setArchive(false);
      toast(command.action === 'archive' ? 'Document archived' : 'Document access updated');
    },
    onError: () => {
      void invalidate();
    },
  });
  const d = doc.data;
  const readOnly = !!d?.archivedAt || !!d?.projectArchived;
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={d?.title ?? 'Document'}
        description="Project document details and access."
      >
        {doc.isPending ? (
          <p role="status">Loading document…</p>
        ) : doc.isError ? (
          <div role="alert">
            <p>{doc.error.message}</p>
            <Button onClick={() => doc.refetch()}>Retry document</Button>
          </div>
        ) : (
          d && (
            <div className="document-detail">
              <p className="document-summary">{d.summary || 'No summary yet.'}</p>
              <p className="document-note">
                Owner: {d.owner.name} · Updated {new Date(d.updatedAt).toLocaleString()}
                {readOnly ? ' · Read-only' : ''}
              </p>
              {d.permissions.edit && !readOnly && (
                <Button variant="outline" onClick={() => setEdit(true)}>
                  <Pencil size={15} />
                  Rename or edit summary
                </Button>
              )}
              {d.permissions.manage && (
                <section aria-label="Document permissions">
                  <h3>Access</h3>
                  <p className="document-note">
                    The owner and workspace administrators always have access. Readers can view;
                    editors can rename and update summaries.
                  </p>
                  <ul className="document-grants">
                    {d.grants?.map((g) => (
                      <li key={g.userId}>
                        <span>
                          {g.member.user.name} · {g.access === 'EDITOR' ? 'Editor' : 'Reader'}
                        </span>
                        {!readOnly && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={change.isPending}
                            onClick={() => change.mutate({ action: 'revoke', userId: g.userId })}
                            aria-label={`Remove access for ${g.member.user.name}`}
                          >
                            Remove
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {!readOnly && (
                    <form
                      className="document-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (target && !change.isPending)
                          change.mutate({ action: 'grant', userId: target });
                      }}
                    >
                      <label>
                        Workspace member
                        <select required value={target} onChange={(e) => setTarget(e.target.value)}>
                          <option value="">Choose a member</option>
                          {data.members
                            .filter((m) => m.user.id !== d.ownerId)
                            .map((m) => (
                              <option key={m.user.id} value={m.user.id}>
                                {m.user.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        Permission
                        <select
                          value={access}
                          onChange={(e) => setAccess(e.target.value as 'READER' | 'EDITOR')}
                        >
                          <option value="READER">Reader</option>
                          <option value="EDITOR">Editor</option>
                        </select>
                      </label>
                      <Button disabled={!target || change.isPending}>
                        {change.isPending ? 'Saving…' : 'Save access'}
                      </Button>
                    </form>
                  )}
                </section>
              )}
              {change.isError && <p role="alert">{change.error.message}</p>}
              {d.permissions.manage && !readOnly && (
                <Button
                  variant="destructive"
                  disabled={change.isPending}
                  onClick={() => setArchive(true)}
                >
                  <Archive size={15} />
                  Archive document
                </Button>
              )}
            </div>
          )
        )}
      </Dialog>
      {edit && d && (
        <DocumentForm
          title="Rename document"
          endpoint={scope(`${base}/${id}`)}
          initial={d}
          onClose={() => {
            setEdit(false);
            void invalidate();
          }}
          onSaved={async () => {
            setEdit(false);
            await invalidate();
          }}
        />
      )}
      {archive && d && (
        <Dialog
          open
          onOpenChange={setArchive}
          title="Archive this document?"
          description="The document and its access list will be retained. Archived documents cannot be edited."
        >
          <p>{d.title}</p>
          {change.isError && <p role="alert">{change.error.message}</p>}
          <div className="document-actions">
            <Button variant="ghost" disabled={change.isPending} onClick={() => setArchive(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={change.isPending}
              onClick={() => change.mutate({ action: 'archive' })}
            >
              {change.isPending ? 'Archiving…' : 'Confirm archive'}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
