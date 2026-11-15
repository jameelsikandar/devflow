'use client';
import { Sparkles, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ChatContext } from '@/lib/chat-presentation';
import { ChatMarkdown } from './markdown';
import { CopyButton } from './copy-button';
export function AIMessage({
  role,
  content,
  context,
  children,
}: {
  role: 'user' | 'assistant';
  content?: string;
  context?: ChatContext;
  children?: ReactNode;
}) {
  return (
    <div className={`chat-message chat-message-${role}`}>
      <div className="chat-message-heading">
        <span>
          {role === 'assistant' ? <Sparkles size={15} /> : <UserRound size={15} />}
          {role === 'assistant' ? 'DevFlow' : 'You'}
        </span>{' '}
        {content && (
          <CopyButton
            text={content}
            label={role === 'assistant' ? 'Copy response' : 'Copy message'}
          />
        )}
      </div>
      {content &&
        (role === 'assistant' ? (
          <ChatMarkdown content={content} context={context} />
        ) : (
          <p className="chat-plain-text">{content}</p>
        ))}
      {children}
    </div>
  );
}
