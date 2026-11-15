import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardOrigin, jsonBody, readLimited } from '../src/lib/server/request';
import { generateAssistant, OpenAICompatibleProvider } from '../src/lib/server/ai';
import { env } from '../src/lib/server/env';
const original = { ...process.env };
afterEach(() => {
  process.env = original;
  vi.unstubAllGlobals();
});
function configure() {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost/devflow_test';
  process.env.APP_URL = 'https://devflow.example';
}
describe('request security', () => {
  it('reports missing database configuration as a server error without exposing values', () => {
    delete process.env.DATABASE_URL;
    expect(() => env()).toThrow('DATABASE_URL');
    try {
      env();
    } catch (error) {
      expect(error).toMatchObject({ status: 500 });
    }
    process.env.DATABASE_URL = 'invalid-private-value';
    expect(() => env()).toThrow('DATABASE_URL');
    expect(() => env()).not.toThrow('invalid-private-value');
  });
  it('requires an exact origin on mutations and allows safe reads', () => {
    configure();
    expect(() =>
      guardOrigin(
        new Request('https://devflow.example/api/tasks', {
          method: 'POST',
          headers: { Origin: 'https://evil.example' },
        }),
      ),
    ).toThrow('origin');
    expect(() =>
      guardOrigin(new Request('https://devflow.example/api/tasks', { method: 'POST' })),
    ).toThrow('origin');
    expect(() =>
      guardOrigin(
        new Request('https://devflow.example/api/tasks', {
          method: 'POST',
          headers: { Origin: 'https://devflow.example' },
        }),
      ),
    ).not.toThrow();
    expect(() => guardOrigin(new Request('https://devflow.example/api/tasks'))).not.toThrow();
  });
  it('rejects oversized bodies even without Content-Length', async () => {
    const request = new Request('http://localhost', { method: 'POST', body: 'a'.repeat(100) });
    await expect(readLimited(request, 40)).rejects.toMatchObject({ status: 413 });
  });
  it('rejects an oversized declared length before reading', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Length': '500' },
      body: '{}',
    });
    await expect(readLimited(request, 40)).rejects.toMatchObject({ status: 413 });
  });
  it('validates JSON content type and syntax', async () => {
    await expect(
      jsonBody(new Request('http://localhost', { method: 'POST', body: '{}' })),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      jsonBody(
        new Request('http://localhost', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'broken',
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      jsonBody(
        new Request('http://localhost', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"name":"Alex"}',
        }),
      ),
    ).resolves.toEqual({ name: 'Alex' });
  });
});
describe('AI abstraction', () => {
  it('fails clearly without an API key and never fabricates a response', async () => {
    configure();
    delete process.env.AI_API_KEY;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(new OpenAICompatibleProvider().generate('system', 'input')).rejects.toMatchObject({
      status: 503,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sends actual records to an injected provider with the requested action', async () => {
    const provider = { generate: vi.fn().mockResolvedValue('Actual provider response') };
    const records = [
      { name: 'Platform', tasks: [{ title: 'Finish permissions', status: 'TODO' }] },
    ];
    await expect(
      generateAssistant('risks', 'Find delivery risks', records, provider),
    ).resolves.toBe('Actual provider response');
    expect(provider.generate.mock.calls[0][0]).toContain('untrusted data');
    expect(JSON.parse(provider.generate.mock.calls[0][1]).projects).toEqual(records);
  });
  it('handles provider errors and empty output without leaking upstream payloads', async () => {
    configure();
    process.env.AI_API_KEY = 'server-key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('private error payload', { status: 401 })),
    );
    await expect(new OpenAICompatibleProvider().generate('sys', 'input')).rejects.toThrow(
      'AI provider returned 401',
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ choices: [] })));
    await expect(new OpenAICompatibleProvider().generate('sys', 'input')).rejects.toThrow(
      'no text',
    );
  });
});
