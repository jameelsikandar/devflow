import { z } from 'zod';
import { priorities, statuses } from './types';
export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((s) => s.toLowerCase()),
  password: z.string().min(1).max(128),
});
export const registerSchema = loginSchema.extend({
  name: z.string().trim().min(2).max(80),
  password: z.string().min(12, 'Use at least 12 characters').max(128),
});
export const projectSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().max(3000).default(''),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#a78bfa'),
});
export const taskSchema = z.object({
  projectId: z.string().min(1),
  parentTaskId: z.string().min(1).nullable().optional(),
  title: z.string().trim().min(2).max(200),
  description: z.string().max(20000).default(''),
  status: z.enum(statuses).default('TODO'),
  priority: z.enum(priorities).default('MEDIUM'),
  assigneeId: z.string().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  isMilestone: z.boolean().default(false),
  labelIds: z.array(z.string()).max(20).default([]),
});
export const taskUpdateSchema = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  description: z.string().max(20000).optional(),
  status: z.enum(statuses).optional(),
  priority: z.enum(priorities).optional(),
  assigneeId: z.string().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  isMilestone: z.boolean().optional(),
  labelIds: z.array(z.string()).max(20).optional(),
  version: z.number().int().min(0),
  position: z.number().finite().min(-1e12).max(1e12).optional(),
});
export const commentSchema = z.object({ body: z.string().trim().min(1).max(10000) });
export const workspaceSchema = z.object({ name: z.string().trim().min(2).max(80) });
export const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((s) => s.toLowerCase()),
});
export const aiSchema = z.object({
  projectId: z.string().optional(),
  action: z.enum(['subtasks', 'description', 'sprint', 'summary', 'priorities', 'risks']),
  prompt: z.string().trim().max(4000).default(''),
});
