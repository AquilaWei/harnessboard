// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FEATURE_LIST_FILE, contextPct, resolveThresholds } from '@harnessboard/shared';
import type {
  AgentRole,
  FeatureSnapshot,
  PlanProposal,
  ReviewRecord,
  ReviewRequest,
  Session,
  Task,
  TaskActivity,
  TaskStatus,
} from '@harnessboard/shared';
import type { HarnessConfig } from './config.js';
import { missingFeatures, readPlan, runVerify } from './loop.js';
import {
  QUOTA_RESUME_PROMPT,
  continuationPrompt,
  initializerPrompt,
  loopSessionPrompt,
  planRevisionPrompt,
} from './prompts.js';
import { parseVerdict, reviewFeedback, reviewPrompt } from './review.js';
import type { SessionOutcome } from './runner.js';
import type { Store } from './store.js';
import { headCommit, mergeBase, porcelainStatus } from './worktree.js';

/** Who runs the next session of a task, what it is asked, and whether it resumes one. */
export interface SessionPlan {
  role: AgentRole;
  agentId: string;
  /** Session to continue; `null` starts a new one. */
  resume: Session | null;
  prompt: string;
}

/** What the workflow needs from the harness: persistence and status changes that notify. */
export interface WorkflowHost {
  readonly store: Store;
  readonly config: HarnessConfig;
  setStatus(id: number, status: TaskStatus, extra?: { resumeAt?: number | null }): Task;
  notice(taskId: number, message: string, sessionId?: string | null): void;
  /** Reports what a running task is doing, for display only. */
  setActivity(taskId: number, activity: TaskActivity): void;
}

/**
 * Decides what each session of a task is asked to do and where the task goes after it.
 * Holds no state of its own; everything it reads comes from the store.
 */
export class Workflow {
  constructor(private readonly host: WorkflowHost) {}

  /**
   * A reviewer session while a review is pending; otherwise an implementer session: fresh
   * for a new task, after a handoff, after review feedback or for the next loop feature, and
   * `--resume` of the previous session after a quota pause, stop or error, but only while
   * that session still has budget.
   */
  plan(task: Task): SessionPlan {
    const last = this.host.store.listSessions(task.id).at(-1);
    const request = this.pendingReview(task.id);
    if (request) return this.reviewPlan(task, request, last);
    if (!last) return this.implement(task, this.firstPrompt(task));
    const feedback = this.inPlanning(task) ? this.pendingPlanFeedback(task.id) : null;
    if (feedback !== null) return this.revisePlan(task, feedback, last);
    if (last.endReason === 'handoff' || last.endReason === 'context_hard_limit') {
      return this.continuation(task, this.handoffNote(task));
    }
    // Each loop feature starts from a clean context; its state lives in the worktree files.
    const loopStepDone = task.mode === 'loop' && last.endReason === 'completed';
    // A session that never reached the model was never saved by the CLI, so it can't be resumed.
    const resumable =
      !loopStepDone &&
      last.role === 'implementer' &&
      last.agentSessionId !== null &&
      last.contextTokens > 0 &&
      this.hasBudget(task, last);
    if (resumable) return this.implement(task, QUOTA_RESUME_PROMPT, last);
    return this.continuation(task, task.mode === 'single' ? this.handoffNote(task) : null);
  }

  /** Agent profile of the task's next session, for per-provider quota checks. */
  nextAgentId(task: Task): string {
    const reviewer = task.agents.reviewer;
    return reviewer && this.pendingReview(task.id) ? reviewer : task.agents.implementer;
  }

  private reviewPlan(task: Task, request: ReviewRequest, last: Session | undefined): SessionPlan {
    const reviewer = task.agents.reviewer!;
    const resumable =
      last?.role === 'reviewer' &&
      last.endReason !== 'completed' &&
      last.agentSessionId !== null &&
      last.contextTokens > 0 &&
      this.hasBudget(task, last);
    if (resumable) {
      return { role: 'reviewer', agentId: reviewer, resume: last, prompt: QUOTA_RESUME_PROMPT };
    }
    const verify = task.mode === 'loop' ? (this.snapshots(task.id).at(-1)?.verify ?? null) : null;
    return {
      role: 'reviewer',
      agentId: reviewer,
      resume: null,
      prompt: reviewPrompt(task.prompt, request, verify),
    };
  }

  /** The phase a planned session works in. */
  phaseOf(task: Task, plan: SessionPlan): TaskActivity {
    if (plan.role === 'reviewer') return { phase: 'reviewing', agentId: plan.agentId };
    const planning =
      task.mode === 'loop' && !existsSync(path.join(task.worktreePath!, FEATURE_LIST_FILE));
    return { phase: planning ? 'planning' : 'implementing', agentId: plan.agentId };
  }

  /** The review waiting to run, if the latest step was sent for review and not yet reviewed. */
  pendingReview(taskId: number): ReviewRequest | null {
    const request = this.host.store.lastEvent(taskId, 'review_request');
    const review = this.host.store.lastEvent(taskId, 'review');
    if (!request || (review && review.id > request.id)) return null;
    return request.data as ReviewRequest;
  }

  /** Requested changes the implementer has not submitted a new step for yet. */
  private openFeedback(taskId: number): string | null {
    const review = this.host.store.lastEvent(taskId, 'review');
    const request = this.host.store.lastEvent(taskId, 'review_request');
    if (!review || (request && request.id > review.id)) return null;
    const record = review.data as ReviewRecord;
    return record.verdict === 'changes' ? reviewFeedback(record) : null;
  }

  private reviews(taskId: number): ReviewRecord[] {
    return this.host.store.eventsOfKind(taskId, 'review').map((e) => e.data as ReviewRecord);
  }

  private implement(task: Task, prompt: string, resume: Session | null = null): SessionPlan {
    return { role: 'implementer', agentId: task.agents.implementer, resume, prompt };
  }

  private firstPrompt(task: Task): string {
    return task.mode === 'loop' ? initializerPrompt(task.prompt, task.verifyCommand) : task.prompt;
  }

  /** A loop task before its plan is approved (or accepted without approval). */
  private inPlanning(task: Task): boolean {
    return task.mode === 'loop' && this.snapshots(task.id).length === 0;
  }

  /** The user's reply to the latest plan proposal, if the planner has not seen it yet. */
  pendingPlanFeedback(taskId: number): string | null {
    const feedback = this.host.store.lastEvent(taskId, 'plan_feedback');
    const proposal = this.host.store.lastEvent(taskId, 'plan');
    if (!feedback || (proposal && proposal.id > feedback.id)) return null;
    return (feedback.data as { message: string }).message;
  }

  /**
   * Continues the planner's own conversation with the user's reply, so it keeps everything
   * it already discussed; starts over from the plan files only when that is not possible.
   */
  private revisePlan(task: Task, message: string, last: Session): SessionPlan {
    const resumable =
      last.role === 'implementer' &&
      last.agentSessionId !== null &&
      last.contextTokens > 0 &&
      this.hasBudget(task, last);
    if (resumable) return this.implement(task, planRevisionPrompt(message), last);
    return this.implement(
      task,
      continuationPrompt(this.firstPrompt(task), null, planRevisionPrompt(message)),
    );
  }

  private continuation(task: Task, note: string | null): SessionPlan {
    const feedback = this.openFeedback(task.id);
    if (task.mode === 'single') {
      return this.implement(task, continuationPrompt(task.prompt, note, feedback));
    }
    // Until the plan is approved, a follow-up session keeps planning, never builds.
    if (this.inPlanning(task) || !existsSync(path.join(task.worktreePath!, FEATURE_LIST_FILE))) {
      return this.implement(task, continuationPrompt(this.firstPrompt(task), note));
    }
    const verify = this.snapshots(task.id).at(-1)?.verify;
    const failed = verify && !verify.ok ? verify : null;
    return this.implement(
      task,
      loopSessionPrompt(task.prompt, task.verifyCommand!, failed, note, feedback),
    );
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
    const window = session.contextWindow ?? this.contextWindow(session.agentId);
    return (
      contextPct(session.contextTokens, window) < resolveThresholds(task.contextPolicy).softPct
    );
  }

  /** Best known window for an agent profile: last reported, then configured, then fallback. */
  contextWindow(agentId: string): number {
    return (
      this.host.store.lastKnownContextWindow(agentId) ??
      this.host.config.agents[agentId]?.contextWindow ??
      this.host.config.fallbackContextWindow
    );
  }

  /** Moves the task on after a session: next session, review, a human, or a pause. */
  async finish(
    task: Task,
    plan: SessionPlan,
    outcome: SessionOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    this.host.notice(
      task.id,
      `session ended: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`,
    );
    if (plan.role === 'reviewer') {
      await this.finishReview(task, plan, outcome);
      return;
    }
    switch (outcome.reason) {
      case 'completed':
        if (task.mode === 'loop') await this.finishLoopStep(task, signal, outcome.finalText);
        else await this.stepDone(task);
        return;
      case 'handoff':
      case 'context_hard_limit':
        this.handOff(task, outcome);
        return;
      default:
        this.interrupted(task, outcome);
    }
  }

  /** Quota, stop and error end a session the same way for every role. */
  private interrupted(task: Task, outcome: SessionOutcome): void {
    switch (outcome.reason) {
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
      default:
        throw new Error(`unexpected session end: ${outcome.reason}`);
    }
  }

  /**
   * An implementer step is finished (a single task's session, or a verified loop feature).
   * With a reviewer, new commits are sent for review first; otherwise the task moves on.
   */
  private async stepDone(task: Task): Promise<void> {
    if (!task.agents.reviewer) {
      this.afterApproval(task);
      return;
    }
    const dir = task.worktreePath!;
    const [head, status] = await Promise.all([headCommit(dir), porcelainStatus(dir)]);
    const reviews = this.reviews(task.id);
    const last = reviews.at(-1);
    if (last && last.head === head && status === '') {
      if (last.verdict === 'approve') {
        this.afterApproval(task);
      } else {
        this.host.notice(task.id, 'no new commits since the review asked for changes');
        this.host.setStatus(task.id, 'review');
      }
      return;
    }
    const approvedAt = reviews.findLastIndex((r) => r.verdict === 'approve');
    const round = reviews.slice(approvedAt + 1).length + 1;
    const since = reviews[approvedAt]?.head ?? (await mergeBase(dir, task.baseRef));
    const request: ReviewRequest = { round, since, head, status };
    this.host.store.appendEvent(task.id, null, 'review_request', request);
    this.host.notice(task.id, `sent for review to ${task.agents.reviewer} (round ${round})`);
    this.host.setStatus(task.id, 'queued');
  }

  /** Where an approved (or unreviewed) step leads: the next loop feature or human review. */
  private afterApproval(task: Task): void {
    if (task.mode === 'single') {
      this.host.setStatus(task.id, 'review');
      return;
    }
    const last = this.snapshots(task.id).at(-1);
    const done = last?.verify?.ok && last.features.every((f) => f.passes);
    this.host.setStatus(task.id, done ? 'review' : 'queued');
  }

  private async finishReview(
    task: Task,
    plan: SessionPlan,
    outcome: SessionOutcome,
  ): Promise<void> {
    const request = this.pendingReview(task.id)!;
    const record = (verdict: ReviewRecord['verdict'], findings: string, head: string) =>
      this.host.store.appendEvent(task.id, null, 'review', {
        round: request.round,
        agentId: plan.agentId,
        verdict,
        findings,
        head,
      } satisfies ReviewRecord);

    if (outcome.reason === 'context_hard_limit' || outcome.reason === 'handoff') {
      record(null, 'The reviewer ran out of context before giving a verdict.', request.head);
      this.host.notice(task.id, 'reviewer ran out of context; needs a human');
      this.host.setStatus(task.id, 'review');
      return;
    }
    if (outcome.reason !== 'completed') {
      this.interrupted(task, outcome); // the review stays pending and runs again
      return;
    }
    const dir = task.worktreePath!;
    const [head, status] = await Promise.all([headCommit(dir), porcelainStatus(dir)]);
    if (head !== request.head || status !== request.status) {
      record(null, 'The reviewer changed the worktree.', head);
      this.host.notice(task.id, 'reviewer changed the worktree; stopping for a human');
      this.host.setStatus(task.id, 'failed');
      return;
    }
    const { verdict, findings } = parseVerdict(outcome.finalText);
    record(verdict, findings, head);
    if (verdict === 'approve') {
      this.host.notice(task.id, `${plan.agentId} approved round ${request.round}`);
      this.afterApproval(task);
    } else if (verdict === null) {
      this.host.notice(task.id, 'reviewer gave no verdict line; needs a human');
      this.host.setStatus(task.id, 'review');
    } else if (request.round >= task.agents.maxReviewRounds) {
      this.host.notice(
        task.id,
        `${plan.agentId} still requests changes after ${request.round} rounds; needs a human`,
      );
      this.host.setStatus(task.id, 'review');
    } else {
      this.host.notice(task.id, `${plan.agentId} requested changes (round ${request.round})`);
      this.host.setStatus(task.id, 'queued');
    }
  }

  /**
   * After a loop session: checks the feature list, runs the verify command independently of
   * what the agent reported, and decides whether to continue, finish, or stop for review.
   */
  private async finishLoopStep(task: Task, signal: AbortSignal, reply: string): Promise<void> {
    let plan: ReturnType<typeof readPlan>;
    try {
      plan = readPlan(task.worktreePath!);
    } catch (err) {
      this.host.notice(task.id, (err as Error).message);
      this.host.setStatus(task.id, 'failed');
      return;
    }
    const { features } = plan;
    const snapshots = this.snapshots(task.id);
    const baseline = snapshots[0];
    if (!baseline && task.confirmPlan) {
      // Nothing is built until the user approves; the approval records the baseline.
      const proposal: PlanProposal = { ...plan, reply };
      this.host.store.appendEvent(task.id, null, 'plan', proposal);
      this.host.notice(
        task.id,
        `plan ready for your review: ${features.length} features, ${plan.questions.length} questions`,
      );
      this.host.setStatus(task.id, 'awaiting_approval');
      return;
    }
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

    const addressingReview = this.openFeedback(task.id) !== null;
    this.host.notice(task.id, `verifying: ${task.verifyCommand}`);
    this.host.setActivity(task.id, { phase: 'verifying', agentId: null });
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

    // Fixing review feedback is expected to add no new features, so it is not a stall.
    const limit = this.host.config.loopStallSessions;
    const recent = [...snapshots.map((s) => s.verifiedPassing), verifiedPassing].slice(
      -(limit + 1),
    );
    const stalled = recent.length === limit + 1 && recent.every((n) => n === recent[0]);
    if (stalled && !addressingReview) {
      this.host.notice(task.id, `no verified progress in ${limit} sessions; stopping for review`);
      this.host.setStatus(task.id, 'failed');
      return;
    }
    if (verify.ok) await this.stepDone(task);
    else this.host.setStatus(task.id, 'queued');
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
