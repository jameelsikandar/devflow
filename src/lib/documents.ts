import { z } from 'zod';
export const documentId = z.string().min(1).max(128);
export const documentCreate = z
  .object({
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().max(2000).default(''),
  })
  .strict();
export const documentVersion = z.object({ version: z.number().int().min(0) }).strict();
export const documentEdit = z
  .object({
    title: documentCreate.shape.title,
    summary: z.string().trim().max(2000).optional(),
    version: z.number().int().min(0),
  })
  .strict();
export const documentGrant = documentVersion.extend({ access: z.enum(['READER', 'EDITOR']) });
export const documentQuery = z
  .object({
    offset: z.coerce.number().int().min(0).max(10000).default(0),
    archived: z.enum(['true', 'false']).default('false'),
  })
  .strict();
export function documentPermissions(role: string, owner: boolean, access?: string) {
  const manage = owner || role === 'OWNER' || role === 'ADMIN';
  return {
    read: manage || access === 'READER' || access === 'EDITOR',
    edit: manage || access === 'EDITOR',
    manage,
  };
}
export interface ProjectDocumentView {
  id: string;
  projectId: string;
  workspaceId: string;
  title: string;
  summary: string;
  ownerId: string;
  version: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  owner: { id: string; name: string };
  permissions: { read: boolean; edit: boolean; manage: boolean };
  grants?: {
    userId: string;
    access: 'READER' | 'EDITOR';
    member: { user: { id: string; name: string } };
  }[];
}
export interface DocumentPage {
  documents: ProjectDocumentView[];
  total: number;
  offset: number;
  hasMore: boolean;
  projectArchived: boolean;
}
