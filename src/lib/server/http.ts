import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { HttpError } from './errors';
import { ProviderRateLimitError } from './provider-rate-limit';
export { HttpError } from './errors';
export { guardOrigin, jsonBody, readLimited } from './request';
export function errorResponse(error: unknown) {
  if (error instanceof ZodError)
    return NextResponse.json(
      {
        error: error.issues[0]
          ? `${error.issues[0].path.join('.') || 'Input'}: ${error.issues[0].message}`
          : 'Invalid input',
        issues: error.flatten(),
      },
      { status: 400 },
    );
  if (error instanceof ProviderRateLimitError)
    return NextResponse.json(
      { error: error.message },
      {
        status: 429,
        headers:
          error.retryAt !== null
            ? { 'Retry-After': String(Math.max(0, Math.ceil((error.retryAt - Date.now()) / 1000))) }
            : {},
      },
    );
  if (error instanceof HttpError)
    return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002')
      return NextResponse.json({ error: 'This record already exists' }, { status: 409 });
    if (error.code === 'P2025')
      return NextResponse.json({ error: 'Record not found' }, { status: 404 });
  }
  console.error('[DevFlow]', error instanceof Error ? error.name : 'Unhandled error');
  return NextResponse.json(
    { error: 'Unable to complete the request. Please try again.' },
    { status: 500 },
  );
}
export const personSelect = {
  id: true,
  name: true,
  email: true,
  avatarType: true,
  updatedAt: true,
} as const;
