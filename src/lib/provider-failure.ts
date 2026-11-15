/** Public, deliberately sanitized error format, also retained in AIRun.error. */
export function providerFailure(message: string | null | undefined) {
  if (!message || !/^(Groq|AI provider) is rate limited or has reached its quota\./.test(message))
    return null;
  const match = /Retry after (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\./.exec(message);
  const value = match ? Date.parse(match[1]) : NaN;
  return {
    provider: message.startsWith('Groq') ? 'Groq' : 'AI provider',
    retryAt: Number.isFinite(value) ? value : null,
  };
}

export function providerErrorMessage(message: string | null | undefined) {
  return message?.startsWith('AI provider returned 429.')
    ? 'The AI provider rate limited this request or exceeded its quota. No retry delay was recorded.'
    : message;
}
