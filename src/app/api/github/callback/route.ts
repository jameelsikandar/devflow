import { z } from 'zod';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { requireUser } from '@/lib/server/auth';
import { encrypt } from '@/lib/server/crypto';
import { env } from '@/lib/server/env';
import { db } from '@/lib/server/db';
import { githubFetch } from '@/lib/server/github';
import { errorResponse, HttpError } from '@/lib/server/http';
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const jar = await cookies();
    const cookie = jar.get('devflow_github_state')?.value;
    const [stateUser, state] = cookie?.split(':') ?? [];
    jar.delete({ name: 'devflow_github_state', path: '/api/github' });
    if (
      stateUser !== user.id ||
      !state ||
      state !== url.searchParams.get('state') ||
      !url.searchParams.get('code')
    )
      throw new HttpError(400, 'GitHub authorization state is invalid. Please connect again.');
    const config = env();
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.GITHUB_CLIENT_ID,
        client_secret: config.GITHUB_CLIENT_SECRET,
        code: url.searchParams.get('code'),
        redirect_uri: `${config.APP_URL}/api/github/callback`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok || typeof data.access_token !== 'string')
      throw new HttpError(502, 'GitHub authorization failed');
    const profile = z
      .object({ login: z.string().min(1).max(100) })
      .parse(await githubFetch('/user', data.access_token));
    await db.gitHubConnection.upsert({
      where: { userId: user.id },
      update: { login: profile.login, encryptedToken: encrypt(data.access_token) },
      create: { userId: user.id, login: profile.login, encryptedToken: encrypt(data.access_token) },
    });
    return NextResponse.redirect(new URL('/?view=github', config.APP_URL));
  } catch (e) {
    return errorResponse(e);
  }
}
