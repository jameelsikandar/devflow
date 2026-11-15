import { cookies } from 'next/headers';
import { db } from './db';
import { digest, token } from './crypto';
import { HttpError } from './http';
export const sessionCookie = 'devflow_session';
export async function currentUser() {
  const raw = (await cookies()).get(sessionCookie)?.value;
  if (!raw) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: digest(raw) },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          passwordHash: true,
          avatarType: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}
export async function requireUser() {
  const user = await currentUser();
  if (!user) throw new HttpError(401, 'Please sign in to continue');
  return user;
}
export async function createSession(userId: string) {
  const raw = token();
  await db.session.create({
    data: {
      userId,
      tokenHash: digest(raw),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14),
    },
  });
  (await cookies()).set(sessionCookie, raw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 14,
  });
}
export async function membership(userId: string, workspaceId: string, admin = false) {
  const member = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!member) throw new HttpError(404, 'Workspace not found');
  if (admin && member.role === 'MEMBER')
    throw new HttpError(403, 'Workspace administrator access required');
  return member;
}
export async function rateLimit(key: string, limit = 20, windowMs = 60000) {
  const now = new Date();
  const rows = await db.$queryRaw<
    { count: number }[]
  >`INSERT INTO "RateLimit" ("key","count","expiresAt") VALUES (${key},1,${new Date(
    now.getTime() + windowMs,
  )}) ON CONFLICT ("key") DO UPDATE SET "count"=CASE WHEN "RateLimit"."expiresAt"<${now} THEN 1 ELSE "RateLimit"."count"+1 END,"expiresAt"=CASE WHEN "RateLimit"."expiresAt"<${now} THEN ${new Date(
    now.getTime() + windowMs,
  )} ELSE "RateLimit"."expiresAt" END RETURNING "count"`;
  if (rows[0].count > limit) throw new HttpError(429, 'Too many requests. Please try again later.');
}
