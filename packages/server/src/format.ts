// SPDX-License-Identifier: Apache-2.0
import type {
  AgentEvent,
  Feature,
  PermissionDecisionRecord,
  PermissionRequest,
  SpecChangeProposal,
  TaskView,
} from '@harnessboard/shared';
import { t } from './i18n.js';

const STATUS_WIDTH = 13;

export function formatTaskRow(task: TaskView): string {
  const ctx = task.context ? `${task.context.pct.toFixed(1)}%`.padStart(6) : '     -';
  const loop = task.loop ? `  [${task.loop.verified}/${task.loop.total}]` : '';
  return `${String(task.id).padStart(4)}  ${task.status.padEnd(STATUS_WIDTH)} ${ctx}  ${task.title}${loop}`;
}

/** One line per feature: a checkmark only when the agent marked it passing. */
export function formatFeature(feature: Feature): string {
  return `  ${feature.passes ? '✓' : '·'} ${feature.id}  ${feature.description}`;
}

/**
 * A spec change waiting for the user: who asked and why, the reply it was read from, the
 * criteria in force and the proposed ones, one under the other, then the commands that
 * decide it. For the user's own request the reason is their message, so the reply is the
 * only place the spec author's explanation and questions show.
 */
export function formatSpecChange(taskId: number, change: SpecChangeProposal): string {
  const indent = (text: string) => text.replace(/^/gm, '    ');
  const proposed = change.criteria
    ? `  ${t('specChangeProposed')}\n${indent(change.criteria)}`
    : `  ${t('specChangeNoCriteria', { id: taskId })}`;
  const reply = change.reply ? [`  ${t('specChangeReply')}`, indent(change.reply)] : [];
  return [
    t(change.from === 'user' ? 'specChangeFromUser' : 'specChangeFromImplementer', {
      reason: change.reason,
    }),
    ...reply,
    `  ${t('specChangeCurrent')}`,
    indent(change.previous),
    proposed,
    t('specChangeNext', { id: taskId }),
  ].join('\n');
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
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
      case 'permission_request': {
        const e = data as PermissionRequest;
        return `  ? ${e.toolName}: ${e.summary} — waiting for permission`;
      }
      case 'permission_decision': {
        const e = data as PermissionDecisionRecord;
        const added = e.rules.length > 0 ? ` (+ ${e.rules.join(', ')})` : '';
        const why = e.message ? `: ${e.message}` : '';
        const who = e.auto
          ? 'allowed by task rules'
          : e.behavior === 'allow'
            ? 'allowed'
            : 'denied';
        return `  ${e.behavior === 'allow' ? '✓' : '✗'} ${e.toolName}: ${who}${added}${why}`;
      }
      case 'init':
        lastPct = -1;
        return `── session ${(data as { sessionId: string }).sessionId} ──`;
      default:
        return null;
    }
  };
}
