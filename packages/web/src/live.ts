// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import type { HarnessEvent } from '@harnessboard/shared';

/**
 * Subscribes to the server's event stream for the lifetime of the component.
 * EventSource reconnects on its own after the server restarts.
 */
export function useLiveEvents(onEvent: (event: HarnessEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    const source = new EventSource('/api/events');
    const listener = (e: MessageEvent<string>) =>
      handler.current(JSON.parse(e.data) as HarnessEvent);
    for (const type of ['agent', 'task', 'deleted', 'harness', 'quota'])
      source.addEventListener(type, listener);
    return () => source.close();
  }, []);
}

/** Calls `fn` at most once per `ms`, trailing, so bursts of events cause one refresh. */
export function useThrottled(fn: () => void, ms: number): () => void {
  const latest = useRef(fn);
  latest.current = fn;
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return () => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      latest.current();
    }, ms);
  };
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}
