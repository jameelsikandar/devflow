/** Opt-in aggregate diagnostics: never pass prompts, messages, credentials or raw headers. */
export function agentDiagnostic(event: string, values: Record<string, number | string | null>) {
  if (process.env.AI_DIAGNOSTICS === '1')
    console.info('[DevFlow AI]', JSON.stringify({ event, ...values }));
}
export function numericMetric(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function safeRateMetrics(headers: Headers) {
  const metric = (key: string) => {
    const text = headers.get(key);
    return text && /^\d+$/.test(text) ? numericMetric(Number(text)) : null;
  };
  return {
    requestLimit: metric('x-ratelimit-limit-requests'),
    requestsRemaining: metric('x-ratelimit-remaining-requests'),
    tokenLimit: metric('x-ratelimit-limit-tokens'),
    tokensRemaining: metric('x-ratelimit-remaining-tokens'),
  };
}
