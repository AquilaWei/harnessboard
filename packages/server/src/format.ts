// SPDX-License-Identifier: Apache-2.0
import type { AgentEvent, TaskView } from '@harnessboard/shared';

const STATUS_WIDTH = 13;

export function formatTaskRow(task: TaskView): string {
  const ctx = task.context ? `${task.context.pct.toFixed(1)}%`.padStart(6) : '     -';
  return `${String(task.id).padStart(4)}  ${task.status.padEnd(STATUS_WIDTH)} ${ctx}  ${task.title}`;
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/**
 * One log line per stored or live event, or `null` for events not worth a line.
 * Context updates arrive on every model call, so only whole-percent changes are shown.
 */
export function createEventFormatter(
  window: number,
): (kind: string, data: unknown) => string | null {
  let lastPct = -1;
  return (kind, data) => {
    switch (kind) {
      case 'text':
        return (data as Extract<AgentEvent, { kind: 'text' }>).text;
      case 'tool_use': {
        const e = data as Extract<AgentEvent, { kind: 'tool_use' }>;
        return `  ▸ ${e.name}: ${e.summary}`;
      }
      case 'context': {
        const pct = Math.floor(((data as { tokens: number }).tokens / window) * 100);
        if (pct === lastPct) return null;
        lastPct = pct;
        return `  · context ${pct}%`;
      }
      case 'compact': {
        const e = data as Extract<AgentEvent, { kind: 'compact' }>;
        return `  · compacted ${formatTokens(e.preTokens)} → ${formatTokens(e.postTokens)}`;
      }
      case 'notice':
        return `[harness] ${(data as { message: string }).message}`;
      case 'init':
        lastPct = -1;
        return `── session ${(data as { sessionId: string }).sessionId} ──`;
      default:
        return null;
    }
  };
}
