// SPDX-License-Identifier: Apache-2.0
import { contextPct } from '@harnessboard/shared';
import type { AgentEvent, QuotaInfo, SessionEndReason, Thresholds } from '@harnessboard/shared';
import type { AgentAdapter, SessionSpec } from './agent.js';
import { spawnLines } from './process.js';
import { reportsDone, wrapUpPrompt } from './prompts.js';

export interface SessionOutcome {
  reason: SessionEndReason;
  /** The agent's last reply; after a wrap-up this is the handoff note. */
  finalText: string;
  /** Latest quota snapshot seen during the session. */
  quota: QuotaInfo | null;
  /** Window reported by the agent, when it got as far as a result. */
  contextWindow: number | null;
  detail: string | null;
}

export interface RunSessionOptions {
  adapter: AgentAdapter;
  spec: SessionSpec;
  prompt: string;
  thresholds: Thresholds;
  /** Best known window for the model; replaced once the agent reports the real one. */
  contextWindow: number;
  /** Aborting stops the session and kills the agent's process tree. */
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  onNotice: (message: string) => void;
  onStderr: (line: string) => void;
}

/**
 * Runs one agent session for a single prompt and reports why it ended.
 *
 * Context budget: crossing the soft threshold injects a wrap-up request mid-turn (the agent
 * picks it up at its next tool boundary); crossing the hard threshold kills the session.
 * Never rejects: spawn failures come back as an `error` outcome.
 */
export async function runSession(options: RunSessionOptions): Promise<SessionOutcome> {
  const { adapter, spec, thresholds, signal } = options;
  let window = options.contextWindow;
  let wrapSent = false;
  let hardHit = false;
  let stopped = false;
  let quota: QuotaInfo | null = null;
  let result: Extract<AgentEvent, { kind: 'result' }> | null = null;

  const child = spawnLines(
    adapter.command,
    adapter.buildArgs(spec),
    spec.cwd,
    (line) => {
      for (const event of adapter.parseLine(line)) handle(event);
    },
    options.onStderr,
  );

  function handle(event: AgentEvent): void {
    options.onEvent(event);
    if (event.kind === 'quota') quota = event.quota;
    if (event.kind === 'context') checkBudget(event.tokens);
    if (event.kind === 'result') {
      result = event;
      if (event.contextWindow) window = event.contextWindow;
      child.closeInput();
    }
  }

  function checkBudget(tokens: number): void {
    const pct = contextPct(tokens, window);
    if (!wrapSent && pct >= thresholds.softPct) {
      wrapSent = true;
      options.onNotice(`context ${pct}% ≥ soft ${thresholds.softPct}%: asking agent to wrap up`);
      child.write(adapter.encodeMessage(wrapUpPrompt(pct)));
    }
    if (!hardHit && pct >= thresholds.hardPct) {
      hardHit = true;
      options.onNotice(`context ${pct}% ≥ hard ${thresholds.hardPct}%: ending session`);
      child.kill();
    }
  }

  const onAbort = () => {
    stopped = true;
    child.kill();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  child.write(adapter.encodeMessage(options.prompt));
  let exitCode: number | null;
  try {
    exitCode = await child.exited;
  } catch (err) {
    return outcome('error', `failed to start ${adapter.command}: ${(err as Error).message}`);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }

  if (stopped) return outcome('stopped');
  if (hardHit) return outcome('context_hard_limit');
  const final = result as Extract<AgentEvent, { kind: 'result' }> | null;
  if (!final) return outcome('error', `agent exited with code ${exitCode} before a result`);
  if (final.isError) {
    const limited = final.apiErrorStatus === 429 || isQuotaLimited(quota);
    return outcome(limited ? 'quota' : 'error', final.text || null);
  }
  // A wrap-up reply may report the task finished; then there is nothing to hand off.
  return outcome(wrapSent && !reportsDone(final.text) ? 'handoff' : 'completed');

  function outcome(reason: SessionEndReason, detail: string | null = null): SessionOutcome {
    const final = result as Extract<AgentEvent, { kind: 'result' }> | null;
    return {
      reason,
      finalText: final?.text ?? '',
      quota,
      contextWindow: final?.contextWindow ?? null,
      detail,
    };
  }
}

/** True when the agent reported that requests are currently being refused. */
export function isQuotaLimited(quota: QuotaInfo | null): boolean {
  return quota !== null && quota.status !== 'allowed' && quota.status !== 'allowed_warning';
}
