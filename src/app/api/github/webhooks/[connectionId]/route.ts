import { NextResponse } from 'next/server';
import { readLimited, errorResponse, HttpError } from '@/lib/server/http';
import { ingestGitHubDelivery } from '@/lib/server/github-repositories';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
) {
  try {
    if (
      request.headers.get('content-encoding') &&
      request.headers.get('content-encoding') !== 'identity'
    )
      throw new HttpError(415, 'Compressed webhook payloads are not supported');
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
      throw new HttpError(415, 'Webhook must use application/json');
    const raw = await readLimited(request, 1024 * 1024);
    const { connectionId } = await context.params;
    const result = await ingestGitHubDelivery(connectionId, raw, request.headers);
    return NextResponse.json(result, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
