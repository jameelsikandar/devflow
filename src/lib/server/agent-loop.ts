import {
  MAX_CALLS,
  MAX_PROPOSALS,
  MAX_ROUNDS,
  isWriteTool,
  parseTool,
  toolDefinitions,
  type AgentMessage,
  type AgentProvider,
  type ToolName,
} from '../agent';
import { HttpError } from './errors';
import { z } from 'zod';
import { agentDiagnostic } from './agent-diagnostics';
import { modelToolResult } from './agent-model-results';

export interface AgentGateway {
  read(name: ToolName, input: unknown): Promise<unknown>;
  preview(name: ToolName, input: unknown): Promise<unknown>;
  canReuseRead?(name: ToolName, input: unknown, output: unknown): Promise<boolean>;
}
/** There is deliberately no mutation method in this interface or model's tools. */
export async function runAgentLoop(
  provider: AgentProvider,
  messages: AgentMessage[],
  gateway: AgentGateway,
  signal: AbortSignal,
  onEvent?: (event: {
    callId: string;
    name: string;
    input: unknown;
    output: unknown;
  }) => Promise<void>,
) {
  const history = [...messages];
  const events: { callId: string; name: string; input: unknown; output: unknown }[] = [];
  const previews: unknown[] = [];
  let reusedReads = 0;
  const seen = new Set<string>();
  const reads = new Map<string, { callId: string; output: unknown }>();
  for (let round = 0; round < MAX_ROUNDS; round++) {
    signal.throwIfAborted();
    if (JSON.stringify(history).length > 160000)
      throw new HttpError(422, 'AI context limit reached. Start a focused conversation.');
    const reply = await provider.complete(history, toolDefinitions, signal);
    if (!reply.tool_calls.length) {
      agentDiagnostic('agent_completed', {
        providerRounds: round + 1,
        toolCalls: events.length,
        reusedReads,
      });
      return { answer: reply.content ?? '', events, previews };
    }
    if (events.length + reply.tool_calls.length > MAX_CALLS)
      throw new HttpError(422, 'AI tool-call limit reached. Ask a smaller question.');
    history.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls });
    for (const call of reply.tool_calls) {
      if (seen.has(call.id))
        throw new HttpError(502, 'The provider reused a tool-call identifier.');
      seen.add(call.id);
      let input: unknown = {};
      let output: unknown;
      let reusedFrom: string | undefined;
      try {
        const parsed: unknown = JSON.parse(call.function.arguments);
        input = parseTool(call.function.name, parsed);
        const name = call.function.name as ToolName;
        if (isWriteTool(name)) {
          if (previews.length >= MAX_PROPOSALS)
            throw new HttpError(422, 'At most six proposals may be made in one turn.');
          reads.clear();
          const preview = await gateway.preview(name, input);
          previews.push(preview);
          output = { status: 'awaiting_user_approval', preview, applied: false };
        } else {
          const args = input as Record<string, unknown>;
          const stable = Object.fromEntries(
            Object.entries(args)
              .filter(
                ([key, value]) =>
                  key !== 'fresh' &&
                  value !== undefined &&
                  value !== false &&
                  !(key === 'query' && value === ''),
              )
              .sort(([a], [b]) => a.localeCompare(b)),
          );
          const key = `${name}:${JSON.stringify(stable)}`;
          const cached = reads.get(key);
          if (!args.fresh && cached && (await gateway.canReuseRead?.(name, input, cached.output))) {
            output = cached.output;
            reusedFrom = cached.callId;
            reusedReads++;
          } else {
            output = await gateway.read(name, input);
            if (output && typeof output === 'object' && !('error' in output))
              reads.set(key, { callId: call.id, output });
          }
        }
      } catch (error) {
        output = {
          error:
            error instanceof HttpError
              ? error.message
              : error instanceof z.ZodError
                ? 'Invalid tool arguments: ' + error.issues.map((i) => i.path.join('.')).join(', ')
                : 'Invalid or unavailable tool request',
          applied: false,
        };
      }
      const event = {
        callId: call.id,
        name: call.function.name,
        input,
        output: reusedFrom
          ? { ...(output as object), readReuse: { sourceCallId: reusedFrom } }
          : output,
      };
      events.push(event);
      await onEvent?.(event);
      const compact = reusedFrom
        ? {
            reusedFromToolCall: reusedFrom,
            note: 'Equivalent authorized read; use the full prior result, including its scope and pagination.',
          }
        : modelToolResult(call.function.name, output);
      const encoded = JSON.stringify(compact);
      history.push({
        role: 'tool',
        tool_call_id: call.id,
        content:
          encoded.length <= 32000
            ? encoded
            : JSON.stringify({
                error: 'Result exceeds context limits. Request fewer tasks or a narrower filter.',
              }),
      });
    }
  }
  throw new HttpError(
    422,
    'AI reasoning limit reached. Ask a narrower question; no changes were applied.',
  );
}
