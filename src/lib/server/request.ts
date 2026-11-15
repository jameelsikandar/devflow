import { env } from './env';
import { HttpError } from './errors';
export function guardOrigin(request: Request) {
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
    request.headers.get('origin') !== new URL(env().APP_URL).origin
  ) {
    throw new HttpError(403, 'Request origin is not allowed');
  }
}
export async function readLimited(request: Request, maximum: number): Promise<Buffer> {
  if (Number(request.headers.get('content-length') ?? 0) > maximum)
    throw new HttpError(413, 'Request too large');
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new HttpError(413, 'Request too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
export async function jsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw new HttpError(415, 'Send JSON with Content-Type: application/json');
  const bytes = await readLimited(request, 64000);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}
