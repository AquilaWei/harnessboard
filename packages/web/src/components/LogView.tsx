// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentEvent, StoredEvent } from '@harnessboard/shared';
import { formatTokens } from '../live';
import { Markdown } from './Markdown';

/**
 * Renders the event log. Context updates arrive on every model call, so only
 * whole-percent changes get a line; unknown kinds are skipped.
 */
export function LogView({ events, window }: { events: StoredEvent[]; window: number }) {
  const { t } = useTranslation();
  const end = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow new output only while the reader is at the bottom of the scroll container.
  // Re-attached when the log first renders, because the end marker only exists then.
  useEffect(() => {
    const container = end.current?.closest('.drawer-body');
    if (!container) return;
    const onScroll = () => {
      stick.current = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
    };
    container.addEventListener('scroll', onScroll);
    return () => container.removeEventListener('scroll', onScroll);
  }, [events.length === 0]);

  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView({ block: 'end' });
  }, [events.length]);

  if (events.length === 0) return <p className="empty">{t('noEvents')}</p>;

  let lastPct = -1;
  const rows = events.map((e) => {
    switch (e.kind) {
      case 'init':
        lastPct = -1;
        return (
          <div key={e.id} className="log-session">
            ── session {(e.data as { sessionId: string }).sessionId} ──
          </div>
        );
      case 'text':
        return (
          <Markdown
            key={e.id}
            className="log-text"
            text={(e.data as Extract<AgentEvent, { kind: 'text' }>).text}
          />
        );
      case 'tool_use': {
        const d = e.data as Extract<AgentEvent, { kind: 'tool_use' }>;
        return (
          <div key={e.id} className="log-tool">
            ▸ {d.name}: {d.summary}
          </div>
        );
      }
      case 'context': {
        const pct = Math.floor(((e.data as { tokens: number }).tokens / window) * 100);
        if (pct === lastPct) return null;
        lastPct = pct;
        return (
          <div key={e.id} className="log-meta">
            · {t('context')} {pct}%
          </div>
        );
      }
      case 'compact': {
        const d = e.data as Extract<AgentEvent, { kind: 'compact' }>;
        return (
          <div key={e.id} className="log-meta">
            · compact {formatTokens(d.preTokens)} → {formatTokens(d.postTokens)}
          </div>
        );
      }
      case 'notice':
        return (
          <div key={e.id} className="log-notice">
            {(e.data as { message: string }).message}
          </div>
        );
      default:
        return null;
    }
  });

  return (
    <div className="log">
      {rows}
      <div ref={end} />
    </div>
  );
}
