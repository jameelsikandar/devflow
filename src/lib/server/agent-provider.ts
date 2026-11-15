import { z } from 'zod';
import type { AgentMessage, AgentProvider } from '../agent';
import { toolDefinitions } from '../agent';
import { env } from './env';
import { HttpError } from './errors';
import { agentDiagnostic, numericMetric, safeRateMetrics } from './agent-diagnostics';
import { retryDeadline } from './provider-rate-limit';
import { providerBackoff } from './provider-rate-limit';

export function agentConfiguration() {
  const config = env();
  const url = new URL(config.AI_BASE_URL);
  const safe =
    !url.username &&
    !url.password &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  return {
    configured: !!config.AI_API_KEY && safe,
    model: config.AI_MODEL,
    reason: !safe
      ? 'AI_BASE_URL must use HTTPS (or HTTP on localhost) without embedded credentials.'
      : !config.AI_API_KEY
        ? 'Configure AI_API_KEY, AI_BASE_URL and AI_MODEL on the server.'
        : null,
  };
}
const replySchema = z.object({
  content: z.string().max(24000).nullable().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        type: z.literal('function'),
        function: z.object({ name: z.string().min(1).max(80), arguments: z.string().max(24000) }),
      }),
    )
    .max(8)
    .default([]),
});
let upstreamRequests = 0;
export class OpenAICompatibleAgentProvider implements AgentProvider {
  async complete(messages: AgentMessage[], tools: typeof toolDefinitions, signal: AbortSignal) {
    const state = agentConfiguration();
    if (!state.configured) throw new HttpError(503, state.reason!);
    const config = env();
    const backoff = providerBackoff(config);
    backoff.check();
    signal.throwIfAborted();
    const requestNumber = ++upstreamRequests;
    agentDiagnostic('provider_request', {
      requestNumber,
      messageCount: messages.length,
      contextBytes: Buffer.byteLength(JSON.stringify(messages)),
      toolDefinitionBytes: Buffer.byteLength(JSON.stringify(tools)),
    });
    let response: Response;
    try {
      response = await fetch(`${config.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.AI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.AI_MODEL,
          messages,
          tools,
          tool_choice: 'auto',
          parallel_tool_calls: false,
          store: false,
          max_tokens: 4000,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
        redirect: 'error',
      });
    } catch {
      throw new HttpError(502, 'The AI provider could not be reached or timed out.');
    }
    agentDiagnostic('provider_response', {
      requestNumber,
      status: response.status,
      ...safeRateMetrics(response.headers),
      retryAt: response.status === 429 ? retryDeadline(response.headers) : null,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) throw backoff.limited(response.headers);
      throw new HttpError(
        502,
        `AI provider returned ${response.status}. ${response.status === 401 || response.status === 403 ? 'Check server credentials and provider access.' : response.status >= 500 ? 'The provider is temporarily unavailable.' : 'The provider rejected the request; review the configured model and tool support.'}`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new HttpError(502, 'The AI provider returned no response.');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 256000) {
          await reader.cancel();
          throw new HttpError(502, 'AI provider response exceeded the size limit.');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'The AI provider response was interrupted.');
    } finally {
      reader.releaseLock();
    }
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      agentDiagnostic('provider_usage', {
        requestNumber,
        promptTokens: numericMetric(data.usage?.prompt_tokens),
        completionTokens: numericMetric(data.usage?.completion_tokens),
        totalTokens: numericMetric(data.usage?.total_tokens),
      });
      if (data.choices?.[0]?.finish_reason === 'length') throw new Error('truncated');
      const result = replySchema.parse(data.choices?.[0]?.message);
      if (!result.content?.trim() && !result.tool_calls.length) throw new Error('empty');
      return { content: result.content ?? null, tool_calls: result.tool_calls };
    } catch {
      throw new HttpError(502, 'The AI provider returned invalid, empty or truncated tool output.');
    }
  }
}
