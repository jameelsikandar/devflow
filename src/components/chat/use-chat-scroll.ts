'use client';
import { useEffect, useRef, useState } from 'react';
export function useChatScroll(conversationId: string, revision: string) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const previous = useRef(conversationId);
  useEffect(() => {
    const changed = previous.current !== conversationId;
    previous.current = conversationId;
    if (changed) pinned.current = true;
    if (pinned.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [conversationId, revision]);
  return {
    ref,
    showLatest,
    onScroll: () => {
      const el = ref.current;
      if (!el) return;
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      setShowLatest(!pinned.current);
    },
    latest: () => {
      pinned.current = true;
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
      setShowLatest(false);
    },
  };
}
