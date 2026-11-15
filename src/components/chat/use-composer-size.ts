'use client';
import { useEffect, useRef } from 'react';
export function resizeComposer(input: HTMLTextAreaElement) {
  input.style.height = 'auto';
  const border = input.offsetHeight - input.clientHeight;
  const contentHeight = input.scrollHeight + border;
  const height = Math.max(40, Math.min(144, contentHeight));
  input.style.height = `${height}px`;
  input.style.overflowY = contentHeight > 144 ? 'auto' : 'hidden';
}
export function useComposerSize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (ref.current) resizeComposer(ref.current);
  }, [value]);
  return ref;
}
