import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { requireUser } from '@/lib/server/auth';
import { token } from '@/lib/server/crypto';
import { env } from '@/lib/server/env';
import { errorResponse, HttpError } from '@/lib/server/http';
export async function GET() {
  try {
    const user = await requireUser();
    const config = env();
    if (
      !config.GITHUB_CLIENT_ID ||
      !config.GITHUB_CLIENT_SECRET ||
      !/^[a-f0-9]{64}$/i.test(config.TOKEN_ENCRYPTION_KEY ?? '')
    )
      throw new HttpError(
        503,
        'Configure GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY first',
      );
    const state = token();
    (await cookies()).set('devflow_github_state', `${user.id}:${state}`, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600,
      path: '/api/github',
    });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', config.GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', `${config.APP_URL}/api/github/callback`);
    url.searchParams.set('scope', 'repo read:user');
    url.searchParams.set('state', state);
    return NextResponse.redirect(url);
  } catch (e) {
    return errorResponse(e);
  }
}
