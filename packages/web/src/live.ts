// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import type { HarnessEvent } from '@harnessboard/shared';
import { api, ApiError, eventsUrl, onSessionChange } from './api';

// `EventSource.CLOSED`: the stream gave up and will not reconnect on its own.
const CLOSED = 2;
// How long to wait before reopening a stream that gave up for a reason other than a 401.
const REOPEN_MS = 3000;

/**
 * Subscribes to the server's event stream for the lifetime of the component.
 * EventSource reconnects on its own after a network failure. It gives up when the server
 * answers with an error instead, e.g. the lock's 401 after a restart dropped every board
 * session. Its 401 never reaches `request()`, so one API call then asks: a 401 there shows the
 * locked or not-paired screen, and anything else (the server still starting, the network)
 * reopens the stream a little later. A new board session (a passkey check on a phone) also
 * reopens the stream with its token: the old token may be dropped by the server.
 */
export function useLiveEvents(onEvent: (event: HarnessEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    const listener = (e: MessageEvent<string>) =>
      handler.current(JSON.parse(e.data) as HarnessEvent);
    let source: EventSource | null = null;
    let reopen: number | null = null;
    let stopped = false;
    const connect = () => {
      if (reopen !== null) window.clearTimeout(reopen);
      reopen = null;
      source?.close();
      const current = new EventSource(eventsUrl());
      source = current;
      for (const type of ['agent', 'task', 'deleted', 'harness', 'quota'])
        current.addEventListener(type, listener);
      current.addEventListener('error', () => {
        if (current.readyState !== CLOSED) return;
        const later = () => {
          // Unmounted, or a new session already reopened the stream.
          if (stopped || source !== current) return;
          reopen = window.setTimeout(connect, REOPEN_MS);
        };
        // A 401 has shown its screen; unlocking or pairing reopens the stream.
        api.status().then(later, (err: unknown) => {
          if (!(err instanceof ApiError && err.status === 401)) later();
        });
      });
    };
    connect();
    const stop = onSessionChange(connect);
    return () => {
      stopped = true;
      stop();
      if (reopen !== null) window.clearTimeout(reopen);
      source?.close();
    };
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
