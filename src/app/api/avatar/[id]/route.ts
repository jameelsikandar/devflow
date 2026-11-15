import { requireUser } from '@/lib/server/auth';
import { db } from '@/lib/server/db';
import { errorResponse, HttpError } from '@/lib/server/http';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await requireUser();
    const { id } = await params;
    if (id !== me.id) {
      const shared = await db.workspaceMember.findFirst({
        where: { userId: id, workspace: { members: { some: { userId: me.id } } } },
      });
      if (!shared) throw new HttpError(404, 'Avatar not found');
    }
    const user = await db.user.findUnique({
      where: { id },
      select: { avatar: true, avatarType: true },
    });
    if (!user?.avatar) throw new HttpError(404, 'Avatar not found');
    return new Response(new Uint8Array(user.avatar), {
      headers: {
        'Content-Type': user.avatarType ?? 'image/png',
        'Cache-Control': 'private, max-age=60',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
