import { z } from 'zod';
import { HttpError } from './errors';
const schema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .refine(
      (value) =>
        URL.canParse(value) && ['postgresql:', 'postgres:'].includes(new URL(value).protocol),
      'DATABASE_URL must be a PostgreSQL URL',
    ),
  APP_URL: z.string().url().default('http://localhost:3000'),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  AI_MODEL: z.string().default('gpt-4.1-mini'),
  GITHUB_DEMO: z.enum(['true', 'false']).default('false'),
});
export function env() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new HttpError(
      500,
      `Server configuration is missing or invalid: ${fields.join(', ')}. Update .env and restart the server.`,
    );
  }
  return result.data;
}
