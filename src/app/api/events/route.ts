import { cookies } from 'next/headers';
import { digest } from '@/lib/server/crypto';
import { requireUser, membership, rateLimit, sessionCookie } from '@/lib/server/auth';
import { db } from '@/lib/server/db';
import { errorResponse, HttpError } from '@/lib/server/http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    await rateLimit(`events:${user.id}`, 30);
    const rawSession = (await cookies()).get(sessionCookie)!.value;
    const tokenHash = digest(rawSession);
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new HttpError(400, 'Workspace required');
    await membership(user.id, workspaceId);
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    let busy = false;
    let fingerprint = '';
    const start = Date.now();
    const stream = new ReadableStream({
      start(controller) {
        const close = () => {
          if (stopped) return;
          stopped = true;
          if (timer) clearInterval(timer);
          try {
            controller.close();
          } catch {}
        };
        request.signal.addEventListener('abort', close, { once: true });
        const tick = async () => {
          if (stopped || busy) return;
          busy = true;
          try {
            // Revalidate membership and session on every poll; streams close periodically to rotate sessions.
            if (Date.now() - start > 240000) {
              close();
              return;
            }
            await membership(user.id, workspaceId);
            const validSession = await db.session.count({
              where: { tokenHash, userId: user.id, expiresAt: { gt: new Date() } },
            });
            if (!validSession) {
              close();
              return;
            }
            const [latest, members] = await Promise.all([
              db.taskActivity.findFirst({
                where: { workspaceId },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                select: { id: true },
              }),
              db.workspaceMember.findMany({
                where: { workspaceId, lastSeenAt: { gte: new Date(Date.now() - 45000) } },
                select: { userId: true },
                orderBy: { userId: 'asc' },
              }),
            ]);
            const next = JSON.stringify({
              activity: latest?.id,
              online: members.map((m) => m.userId),
            });
            if (next !== fingerprint) {
              fingerprint = next;
              controller.enqueue(new TextEncoder().encode(`data: ${next}\n\n`));
            } else controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
          } catch {
            close();
          } finally {
            busy = false;
          }
        };
        controller.enqueue(new TextEncoder().encode('retry: 3000\n\n'));
        void tick();
        timer = setInterval(() => void tick(), 2000);
      },
      cancel() {
        stopped = true;
        if (timer) clearInterval(timer);
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
