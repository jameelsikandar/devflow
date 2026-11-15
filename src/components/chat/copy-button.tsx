'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
export function CopyButton({ text, label = 'Copy response' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <span className="chat-copy-control">
      <button
        type="button"
        className="chat-copy"
        aria-label={label}
        onClick={async () => {
          try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
            await navigator.clipboard.writeText(text);
            setState('copied');
          } catch {
            setState('failed');
          }
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setState('idle'), 2200);
        }}
      >
        {state === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        <span>{state === 'copied' ? 'Copied' : label}</span>
      </button>
      <span role="status" className={state === 'failed' ? 'chat-copy-error' : 'sr-only'}>
        {state === 'failed'
          ? 'Copy unavailable. Select the text to copy.'
          : state === 'copied'
            ? `${label} copied`
            : ''}
      </span>
    </span>
  );
}
