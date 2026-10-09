// SPDX-License-Identifier: Apache-2.0
import type {
  AgentEvent,
  Feature,
  ModelInfo,
  PermissionDecisionRecord,
  PermissionRequest,
  SpecChangeProposal,
  TaskAgents,
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

/**
 * `hb models`: each role's profile, model and effort, one role per line. An unset model or
 * effort shows as the default label, since the profile or the CLI then decides.
 */
export function formatTaskAgents(a: TaskAgents): string[] {
  const shown = (model?: string | null, effort?: string | null) =>
    `${model ?? t('defaultModel')}  ${effort ?? t('defaultEffort')}`;
  return [
    a.spec
      ? `spec         ${a.spec}  ${shown(a.specModel, a.specEffort)}`
      : `spec         ${t('sameAsImplementer')}`,
    `designer     ${a.designer ?? '-'}  ${a.designer ? shown(a.designerModel, a.designerEffort) : ''}`,
    `implementer  ${a.implementer}  ${shown(a.implementerModel, a.implementerEffort)}`,
    `tester       ${a.tester ?? '-'}  ${a.tester ? shown(a.testerModel, a.testerEffort) : ''}`,
    `reviewer     ${a.reviewer ?? '-'}  ${a.reviewer ? shown(a.reviewerModel, a.reviewerEffort) : ''}`,
  ];
}

/**
 * `hb agents --models`: a model's line, then its effort ids (what `--effort` takes) on an
 * indented line when it offers a choice.
 */
export function formatModel(m: ModelInfo): string[] {
  const details = [m.description, m.note && `(${m.note})`, m.more && t('moreModel')];
  const line = `${m.id.padEnd(28)} ${m.name.padEnd(14)} ${details.filter(Boolean).join(' ')}`;
  if (m.efforts.length === 0) return [line.trimEnd()];
  const efforts = m.efforts.map((e) => e.id).join(', ');
  const fallback = m.defaultEffort ? ` ${t('effortDefault', { effort: m.defaultEffort })}` : '';
  return [line.trimEnd(), `  ${t('effortList', { efforts })}${fallback}`];
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
