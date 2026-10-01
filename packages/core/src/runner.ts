// SPDX-License-Identifier: Apache-2.0
import { contextPct } from '@harnessboard/shared';
import type {
  AgentEvent,
  QuotaInfo,
  RunUsage,
  SessionEndReason,
  Thresholds,
} from '@harnessboard/shared';
import type { AgentAdapter, PermissionReply, SessionSpec } from './agent.js';
import { spawnLines } from './process.js';
import { COMPACT_COMMAND, reportsDone, wrapUpPrompt } from './prompts.js';

const STDERR_TAIL_LINES = 5;

type ResultEvent = Extract<AgentEvent, { kind: 'result' }>;
type PermissionRequestEvent = Extract<AgentEvent, { kind: 'permission_request' }>;

export interface SessionOutcome {
  reason: SessionEndReason;
  /** The agent's last reply; after a wrap-up this is the handoff note. */
  finalText: string;
  /** Latest quota snapshot seen during the session. */
  quota: QuotaInfo | null;
  /** Window reported by the agent, when it got as far as a result. */
  contextWindow: number | null;
  detail: string | null;
  /** The conversation's totals at its latest result, `/compact` included. */
  usage: RunUsage | null;
}

export interface RunSessionOptions {
  adapter: AgentAdapter;
  /** `spec.prompt` is the first message. */
  spec: SessionSpec;
  thresholds: Thresholds;
  /** `false` never asks for a wrap-up (reviewers have nothing to commit); hard still applies. */
  wrapUp?: boolean;
  /**
   * Compact the conversation with `/compact` once the agent's turn has ended at or past
   * `thresholds.compactPct`; only for CLIs with mid-turn input. Defaults to `false`.
   */
  compact?: boolean;
  /** Best known window for the model; replaced once the agent reports the real one. */
  contextWindow: number;
  /** Aborting stops the session and kills the agent's process tree. */
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  /**
   * Decides a tool use the agent asked about (`spec.askPermission`). The agent waits, with
   * its process running, until the promise settles; stopping the session ends the wait.
   */
  onPermissionRequest?: (event: PermissionRequestEvent) => Promise<PermissionReply>;
  onNotice: (message: string) => void;
  onStderr: (line: string) => void;
}

/**
 * Runs one agent session for a single prompt and reports why it ended.
 *
 * Compaction: the agent is never interrupted for it. When a turn ends at or past the
 * compact threshold, the runner sends `/compact` before closing the session, so the
 * conversation is small when it is resumed later (a chat, a quota pause, the start of work
 * after a criteria discussion). The outcome is the agent's own reply; the compaction's
 * empty result is not reported, and a failed compaction only adds a notice.
 *
 * Context budget: crossing the soft threshold asks the agent to wrap up. A CLI that reads
 * stdin mid-turn gets the request right away (at its next tool boundary); for any other CLI
 * the request is sent as a resumed turn once the current one finishes. Crossing the hard
 * threshold kills the session.
 * Never rejects: spawn failures come back as an `error` outcome.
 */
export async function runSession(options: RunSessionOptions): Promise<SessionOutcome> {
  const { adapter, spec, thresholds, signal } = options;
  const streaming = adapter.capabilities.midTurnInput;
  let window = options.contextWindow;
  let agentSessionId = spec.sessionId;
  let wrapPct = null as number | null; // set when the soft threshold is crossed
  let wrapSent = false;
  let hardHit = false;
  let stopped = false;
  const compactPct = streaming && options.compact ? thresholds.compactPct : null;
  let lastPct = 0; // context use after the latest model call
  let compacting = false;
  let compacted = false; // the CLI reported the compaction asked for
  let reply: ResultEvent | null = null; // the agent's own result, kept while compacting
  let quota: QuotaInfo | null = null;
  let result: ResultEvent | null = null;
  // Totals are cumulative for the conversation, so the latest report replaces the earlier.
  let usage: RunUsage | null = null;
  // Kept to explain an exit without a result; the CLI reports such failures on stderr.
  const stderrTail: string[] = [];
  let kill = () => {};

  const onAbort = () => {
    stopped = true;
    kill();
  };
  if (signal.aborted) stopped = true;
  else signal.addEventListener('abort', onAbort, { once: true });

  let turn: SessionSpec = spec;
  let exitCode: number | null = null;
  try {
    while (!stopped) {
      result = null;
      exitCode = await runTurn(turn);
      // Deferred wrap-up for CLIs without mid-turn input: resume with the request.
      const pct = wrapPct;
      const deferred = !streaming && pct !== null && !wrapSent;
      if (!deferred || stopped || hardHit || !result || (result as ResultEvent).isError) break;
      if (!agentSessionId) break; // nothing to resume; the session ends as completed
      wrapSent = true;
      turn = { ...spec, sessionId: agentSessionId, resume: true, prompt: wrapUpPrompt(pct) };
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const hint =
      e.code === 'ENOENT'
        ? " (not found; check the agent profile's command, or set HARNESSBOARD_CLAUDE_PATH for claude)"
        : '';
    return outcome('error', `failed to start ${adapter.command}${hint}: ${e.message}`);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }

  if (stopped) return outcome('stopped');
  if (hardHit) return outcome('context_hard_limit');
  const final = result as ResultEvent | null;
  if (!final) {
    const stderr = stderrTail.length > 0 ? `: ${stderrTail.join(' / ')}` : '';
    return outcome('error', `agent exited with code ${exitCode} before a result${stderr}`);
  }
  if (final.isError) {
    const limited = final.apiErrorStatus === 429 || isQuotaLimited(quota);
    return outcome(limited ? 'quota' : 'error', final.text || stderrTail.join(' / ') || null);
  }
  // A wrap-up reply may report the task finished; then there is nothing to hand off.
  return outcome(wrapSent && !reportsDone(final.text) ? 'handoff' : 'completed');

  /** Runs one CLI process until it exits; rejects only when it cannot be started. */
  function runTurn(turnSpec: SessionSpec): Promise<number | null> {
    const child = spawnLines(
      adapter.command,
      adapter.buildArgs(turnSpec),
      turnSpec.cwd,
      (line) => {
        for (const event of adapter.parseLine(line)) handle(event);
      },
      (line) => {
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
        options.onStderr(line);
      },
    );
    kill = child.kill;
    if (streaming) child.write(adapter.encodeMessage(turnSpec.prompt));
    else child.closeInput(); // the prompt went in as an argument

    function handle(event: AgentEvent): void {
      if (event.kind === 'result' && event.usage) usage = event.usage;
      if (compacting && event.kind === 'result') {
        finishCompaction(event);
        return;
      }
      options.onEvent(event);
      if (event.kind === 'init' && event.sessionId) agentSessionId = event.sessionId;
      if (event.kind === 'quota') quota = event.quota;
      if (event.kind === 'context') checkBudget(event.tokens);
      if (event.kind === 'compact' && compacting) {
        compacted = true;
        options.onNotice(`context compacted: ${event.preTokens} → ${event.postTokens} tokens`);
      }
      if (event.kind === 'permission_request') answer(event);
      if (event.kind === 'result') {
        result = event;
        if (event.contextWindow) window = event.contextWindow;
        if (!startCompaction(event)) child.closeInput();
      }
    }

    function answer(event: PermissionRequestEvent): void {
      const decide = options.onPermissionRequest;
      const reply = decide
        ? decide(event)
        : Promise.resolve<PermissionReply>({ behavior: 'deny', message: 'nobody to ask' });
      void reply.then(
        (r) => child.write(adapter.encodePermissionReply(event, r)),
        (err: Error) =>
          child.write(
            adapter.encodePermissionReply(event, { behavior: 'deny', message: err.message }),
          ),
      );
    }

    /**
     * Sends `/compact` after a turn that ended normally past the compact threshold, unless
     * the session is being handed off anyway; `true` when it did.
     */
    function startCompaction(event: ResultEvent): boolean {
      const due = compactPct !== null && lastPct >= compactPct;
      if (!due || event.isError || stopped || hardHit || wrapSent) return false;
      options.onNotice(`context ${lastPct}% ≥ compact ${compactPct}%: compacting after the turn`);
      compacting = true;
      reply = event;
      child.write(adapter.encodeMessage(COMPACT_COMMAND));
      return true;
    }

    /** The compaction's own (empty) result: keep the agent's reply as the outcome. */
    function finishCompaction(event: ResultEvent): void {
      compacting = false;
      if (!compacted) {
        options.onNotice(
          `the conversation was not compacted${event.isError ? `: ${event.text}` : ''}`,
        );
      }
      result = reply;
      child.closeInput();
    }

    function checkBudget(tokens: number): void {
      const pct = contextPct(tokens, window);
      lastPct = pct;
      if (options.wrapUp !== false && wrapPct === null && pct >= thresholds.softPct) {
        wrapPct = pct;
        const when = streaming
          ? 'asking agent to wrap up'
          : 'will ask for a wrap-up after this turn';
        options.onNotice(`context ${pct}% ≥ soft ${thresholds.softPct}%: ${when}`);
        if (streaming) {
          wrapSent = true;
          child.write(adapter.encodeMessage(wrapUpPrompt(pct)));
        }
      }
      if (!hardHit && pct >= thresholds.hardPct) {
        hardHit = true;
        options.onNotice(`context ${pct}% ≥ hard ${thresholds.hardPct}%: ending session`);
        child.kill();
      }
    }

    return child.exited;
  }

  function outcome(reason: SessionEndReason, detail: string | null = null): SessionOutcome {
    const final = result as ResultEvent | null;
    return {
      reason,
      finalText: final?.text ?? '',
      quota,
      contextWindow: final?.contextWindow ?? null,
      detail,
      usage,
    };
  }
}

/** True when the agent reported that requests are currently being refused. */
export function isQuotaLimited(quota: QuotaInfo | null): boolean {
  return quota !== null && quota.status !== 'allowed' && quota.status !== 'allowed_warning';
}
