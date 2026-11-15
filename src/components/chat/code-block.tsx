'use client';
import { useMemo } from 'react';
import tokens, { matchToToken } from 'js-tokens';
import { CopyButton } from './copy-button';
const supported = new Set(['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx', 'json', 'jsonc']);
const keywords = new Set(
  'async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while yield as'.split(
    ' ',
  ),
);
export function codeTokens(code: string, language: string) {
  if (!supported.has(language) || code.length > 20000) return [{ text: code, kind: '' }];
  const regex = new RegExp(tokens.source, 'g');
  const result: { text: string; kind: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code))) {
    if (!match[0].length) break;
    const token = matchToToken(match);
    const kind =
      token.type === 'name' && keywords.has(token.value)
        ? 'keyword'
        : ((
            {
              string: 'string',
              number: 'number',
              comment: 'comment',
              regex: 'string',
              punctuator: 'punctuation',
            } as Record<string, string>
          )[token.type] ?? '');
    result.push({ text: token.value, kind });
  }
  return result;
}
export function CodeBlock({ code, language = '' }: { code: string; language?: string }) {
  const normalized = language
    .toLowerCase()
    .split(/\s+/)[0]
    .replace(/[^a-z0-9+#-]/g, '')
    .slice(0, 30);
  const highlighted = useMemo(() => codeTokens(code, normalized), [code, normalized]);
  return (
    <div className="chat-code-block">
      <div className="chat-code-heading">
        <span>{normalized || 'Plain text'}</span>
        <CopyButton text={code} label="Copy code" />
      </div>
      <pre tabIndex={0} aria-label={`${normalized || 'Plain text'} code`}>
        <code>
          {highlighted.map((token, i) =>
            token.kind ? (
              <span className={`syntax-${token.kind}`} key={i}>
                {token.text}
              </span>
            ) : (
              token.text
            ),
          )}
        </code>
      </pre>
    </div>
  );
}
