'use client';
import { Fragment, useMemo, type ReactNode } from 'react';
import { Lexer, type Token, type Tokens } from 'marked';
import { decodeHTML } from 'entities';
import { safeMarkdownURL, verifiedTask, type ChatContext } from '@/lib/chat-presentation';
import { CodeBlock } from './code-block';

// Marked is used ONLY as a tokenizer. No HTML parser, raw HTML, embeds or image requests.
export function ChatMarkdown({ content, context }: { content: string; context?: ChatContext }) {
  const parsed = useMemo(() => {
    if (content.length > 64000) return null;
    try {
      return Lexer.lex(content, { gfm: true, breaks: true });
    } catch {
      return null;
    }
  }, [content]);
  let budget = 12000;
  function text(value: string, references = true): ReactNode {
    const decoded = decodeHTML(value);
    return decoded.split(/(\bDEV[-–]\d+\b)/gi).map((part, i) => {
      const task = references ? verifiedTask(context, part) : undefined;
      return task && context?.openTask ? (
        <button
          type="button"
          className="chat-task-reference"
          key={i}
          onClick={() => context.openTask?.(task.id)}
          aria-label={`Open DEV-${task.number}: ${task.title}`}
        >
          {part}
        </button>
      ) : (
        part
      );
    });
  }
  function nodes(tokens: Token[] | undefined, depth = 0, references = true): ReactNode {
    if (!tokens) return null;
    if (depth > 32) return tokens.map((token) => token.raw).join('');
    return tokens.map((token, index) => {
      if (--budget < 0) return token.raw;
      const inner = (children: Token[] | undefined) => nodes(children, depth + 1, references);
      let result: ReactNode;
      switch (token.type) {
        case 'space':
          return null;
        case 'html':
          return null;
        case 'heading': {
          const t = token as Tokens.Heading;
          const heading = [null, 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'][t.depth] as 'h1';
          const Heading = heading || 'h3';
          result = <Heading>{inner(t.tokens)}</Heading>;
          break;
        }
        case 'paragraph':
          result = <p>{inner((token as Tokens.Paragraph).tokens)}</p>;
          break;
        case 'text':
        case 'escape': {
          const t = token as Tokens.Text;
          result = t.tokens ? inner(t.tokens) : text(t.text, references);
          break;
        }
        case 'strong':
          result = <strong>{inner((token as Tokens.Strong).tokens)}</strong>;
          break;
        case 'em':
          result = <em>{inner((token as Tokens.Em).tokens)}</em>;
          break;
        case 'del':
          result = <del>{inner((token as Tokens.Del).tokens)}</del>;
          break;
        case 'br':
          result = <br />;
          break;
        case 'hr':
          result = <hr />;
          break;
        case 'codespan':
          result = <code className="chat-inline-code">{(token as Tokens.Codespan).text}</code>;
          break;
        case 'code': {
          const t = token as Tokens.Code;
          result = <CodeBlock code={t.text} language={t.lang} />;
          break;
        }
        case 'blockquote':
          result = <blockquote>{inner((token as Tokens.Blockquote).tokens)}</blockquote>;
          break;
        case 'list': {
          const t = token as Tokens.List;
          const List = t.ordered ? 'ol' : 'ul';
          result = (
            <List start={t.ordered ? t.start || 1 : undefined}>
              {t.items.map((item, i) => (
                <li key={i} className={item.task ? 'chat-checklist-item' : undefined}>
                  {item.task && (
                    <input
                      type="checkbox"
                      checked={!!item.checked}
                      disabled
                      aria-label={item.checked ? 'Completed item' : 'Incomplete item'}
                    />
                  )}
                  {inner(item.tokens)}
                </li>
              ))}
            </List>
          );
          break;
        }
        case 'table': {
          const t = token as Tokens.Table;
          result = (
            <div
              className="chat-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Response table"
            >
              <table>
                <thead>
                  <tr>
                    {t.header.map((cell, i) => (
                      <th scope="col" key={i} style={{ textAlign: t.align[i] ?? undefined }}>
                        {inner(cell.tokens)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j} style={{ textAlign: t.align[j] ?? undefined }}>
                          {inner(cell.tokens)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
          break;
        }
        case 'link': {
          const t = token as Tokens.Link;
          const task = t.href.startsWith('devflow-task:')
            ? verifiedTask(context, t.href.slice(13))
            : undefined;
          const href = safeMarkdownURL(decodeHTML(t.href));
          result =
            task && context?.openTask ? (
              <button
                type="button"
                className="chat-task-reference"
                onClick={() => context.openTask?.(task.id)}
              >
                {nodes(t.tokens, depth + 1, false)}
              </button>
            ) : href ? (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                {nodes(t.tokens, depth + 1, false)}
              </a>
            ) : (
              <span>{nodes(t.tokens, depth + 1, false)}</span>
            );
          break;
        }
        case 'image':
          result = <span>{text((token as Tokens.Image).text, false)}</span>;
          break;
        default:
          result =
            'text' in token && typeof token.text === 'string' ? text(token.text, references) : null;
      }
      return <Fragment key={index}>{result}</Fragment>;
    });
  }
  return (
    <div className="chat-markdown">
      {parsed ? nodes(parsed) : <p className="chat-plain-text">{content}</p>}
    </div>
  );
}
