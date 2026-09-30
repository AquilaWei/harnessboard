// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FEATURE_LIST_FILE, contextPct, resolveThresholds } from '@harnessboard/shared';
import type { Feature, FeatureSnapshot, Session, Task, TaskStatus } from '@harnessboard/shared';
import type { HarnessConfig } from './config.js';
import { missingFeatures, readFeatureList, runVerify } from './loop.js';
import {
  QUOTA_RESUME_PROMPT,
  continuationPrompt,
  initializerPrompt,
  loopSessionPrompt,
} from './prompts.js';
import type { SessionOutcome } from './runner.js';
import type { Store } from './store.js';

/** How the next session of a task starts. */
export type SessionPlan = { resumeId: string | null; prompt: string };

/** What the workflow needs from the harness: persistence and status changes that notify. */
export interface WorkflowHost {
  readonly store: Store;
  readonly config: HarnessConfig;
  setStatus(id: number, status: TaskStatus, extra?: { resumeAt?: number | null }): Task;
  notice(taskId: number, message: string, sessionId?: string | null): void;
}

/**
 * Decides what each session of a task is asked to do and where the task goes after it.
 * Holds no state of its own; everything it reads comes from the store.
 */
export class Workflow {
  constructor(private readonly host: WorkflowHost) {}

  /**
   * Fresh session for a new task, after a handoff, or for the next loop feature; `--resume`
   * of the previous session after a quota pause, stop or error, but only while that session
   * still has budget.
   */
  plan(task: Task): SessionPlan {
    const last = this.host.store.listSessions(task.id).at(-1);
    if (!last) return { resumeId: null, prompt: this.firstPrompt(task) };
    if (last.endReason === 'handoff' || last.endReason === 'context_hard_limit') {
      return this.continuation(task, this.handoffNote(task));
    }
    // Each loop feature starts from a clean context; its state lives in the worktree files.
    const loopStepDone = task.mode === 'loop' && last.endReason === 'completed';
    // A session that never reached the model was never saved by the CLI, so it can't be resumed.
    const resumable = !loopStepDone && last.contextTokens > 0 && this.hasBudget(task, last);
    if (resumable) return { resumeId: last.id, prompt: QUOTA_RESUME_PROMPT };
    return this.continuation(task, task.mode === 'single' ? this.handoffNote(task) : null);
  }

  private firstPrompt(task: Task): string {
    return task.mode === 'loop' ? initializerPrompt(task.prompt, task.verifyCommand!) : task.prompt;
  }

  private continuation(task: Task, note: string | null): SessionPlan {
    if (task.mode === 'single') {
      return { resumeId: null, prompt: continuationPrompt(task.prompt, note) };
    }
    // The initializer was cut off before it wrote the feature list; let it finish planning.
    if (!existsSync(path.join(task.worktreePath!, FEATURE_LIST_FILE))) {
      return { resumeId: null, prompt: continuationPrompt(this.firstPrompt(task), note) };
    }
    const verify = this.snapshots(task.id).at(-1)?.verify;
    const failed = verify && !verify.ok ? verify : null;
    return {
      resumeId: null,
      prompt: loopSessionPrompt(task.prompt, task.verifyCommand!, failed, note),
    };
  }

  private handoffNote(task: Task): string | null {
    const data = this.host.store.lastEvent(task.id, 'handoff')?.data as
      { note?: string } | undefined;
    return data?.note ?? null;
  }

  private snapshots(taskId: number): FeatureSnapshot[] {
    return this.host.store.eventsOfKind(taskId, 'features').map((e) => e.data as FeatureSnapshot);
  }

  private hasBudget(task: Task, session: Session): boolean {
    const window = session.contextWindow ?? this.contextWindow();
    return (
      contextPct(session.contextTokens, window) < resolveThresholds(task.contextPolicy).softPct
    );
  }

  contextWindow(): number {
    return this.host.store.lastKnownContextWindow() ?? this.host.config.fallbackContextWindow;
  }

  async finish(task: Task, outcome: SessionOutcome, signal: AbortSignal): Promise<void> {
    this.host.notice(
      task.id,
      `session ended: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`,
    );
    switch (outcome.reason) {
      case 'completed':
        if (task.mode === 'loop') await this.finishLoopStep(task, signal);
        else this.host.setStatus(task.id, 'review');
        return;
      case 'handoff':
      case 'context_hard_limit':
        this.handOff(task, outcome);
        return;
      case 'quota': {
        const resumeAt =
          outcome.quota?.resetsAt ?? Date.now() + this.host.config.quotaRetryMinutes * 60_000;
        this.host.setStatus(task.id, 'waiting_quota', { resumeAt });
        return;
      }
      case 'stopped':
        this.host.setStatus(task.id, 'stopped');
        return;
      case 'error':
        this.host.setStatus(task.id, 'failed');
        return;
    }
  }

  /**
   * After a loop session: checks the feature list, runs the verify command independently of
   * what the agent reported, and decides whether to continue, finish, or stop for review.
   */
  private async finishLoopStep(task: Task, signal: AbortSignal): Promise<void> {
    let features: Feature[];
    try {
      features = readFeatureList(task.worktreePath!);
    } catch (err) {
      this.host.notice(task.id, (err as Error).message);
      this.host.setStatus(task.id, 'failed');
      return;
    }
    const snapshots = this.snapshots(task.id);
    const baseline = snapshots[0];
    if (!baseline) {
      // The initializer only plans; there is nothing to verify yet.
      this.recordSnapshot(task.id, { features, verify: null, verifiedPassing: 0 });
      this.host.notice(task.id, `feature list created: ${features.length} features`);
      this.host.setStatus(task.id, 'queued');
      return;
    }
    const missing = missingFeatures(baseline.features, features);
    if (missing.length > 0) {
      this.host.notice(
        task.id,
        `features removed from ${FEATURE_LIST_FILE}: ${missing.join(', ')}`,
      );
      this.host.setStatus(task.id, 'failed');
      return;
    }

    this.host.notice(task.id, `verifying: ${task.verifyCommand}`);
    const timeoutMs = this.host.config.verifyTimeoutMinutes * 60_000;
    const verify = await runVerify(task.verifyCommand!, task.worktreePath!, signal, timeoutMs);
    if (signal.aborted) {
      this.host.setStatus(task.id, 'stopped');
      return;
    }
    const claimed = features.filter((f) => f.passes).length;
    // Claims made while verification fails are not credited.
    const verifiedPassing = verify.ok ? claimed : snapshots.at(-1)!.verifiedPassing;
    this.recordSnapshot(task.id, { features, verify, verifiedPassing });
    this.host.notice(
      task.id,
      verify.ok
        ? `verify passed: ${claimed}/${features.length} features done`
        : `verify failed (${verify.timedOut ? 'timed out' : `exit ${verify.exitCode}`})`,
    );

    if (verify.ok && claimed === features.length) {
      this.host.setStatus(task.id, 'review');
      return;
    }
    const limit = this.host.config.loopStallSessions;
    const recent = [...snapshots.map((s) => s.verifiedPassing), verifiedPassing].slice(
      -(limit + 1),
    );
    if (recent.length === limit + 1 && recent.every((n) => n === recent[0])) {
      this.host.notice(task.id, `no verified progress in ${limit} sessions; stopping for review`);
      this.host.setStatus(task.id, 'failed');
      return;
    }
    this.host.setStatus(task.id, 'queued');
  }

  private recordSnapshot(taskId: number, snapshot: FeatureSnapshot): void {
    this.host.store.appendEvent(taskId, null, 'features', snapshot);
  }

  private handOff(task: Task, outcome: SessionOutcome): void {
    const note = outcome.reason === 'handoff' && outcome.finalText ? outcome.finalText : null;
    this.host.store.appendEvent(task.id, null, 'handoff', { note });
    // Counted since the last completed session, so a long loop of features is not capped.
    const sessions = this.host.store.listSessions(task.id);
    const sinceCompleted = sessions.slice(
      sessions.findLastIndex((s) => s.endReason === 'completed') + 1,
    );
    const handoffs = sinceCompleted.filter(
      (s) => s.endReason === 'handoff' || s.endReason === 'context_hard_limit',
    ).length;
    if (handoffs >= this.host.config.maxHandoffs) {
      this.host.notice(task.id, `reached ${handoffs} handoffs (maxHandoffs); stopping for review`);
      this.host.setStatus(task.id, 'failed');
      return;
    }
    this.host.setStatus(task.id, 'queued');
  }
}
