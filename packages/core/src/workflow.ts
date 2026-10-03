// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  FEATURE_LIST_FILE,
  contextPct,
  resolveThresholds,
  roleAgent,
  toQuestions,
} from '@harnessboard/shared';
import type {
  AgentRole,
  CriteriaProposal,
  DesignNote,
  FeatureSnapshot,
  MergeConflict,
  PlanProposal,
  ReviewRecord,
  ReviewRequest,
  Session,
  Task,
  TaskActivity,
  TaskStatus,
} from '@harnessboard/shared';
import type { SessionAccess } from './agent.js';
import type { HarnessConfig } from './config.js';
import { missingFeatures, readPlan, runVerify } from './loop.js';
import {
  QUOTA_RESUME_PROMPT,
  continuationPrompt,
  criteriaApprovedPrompt,
  criteriaPrompt,
  criteriaRevisionPrompt,
  designPrompt,
  initializerPrompt,
  loopSessionPrompt,
  mergeConflictPrompt,
  parseCriteria,
  parseQuestions,
  planRevisionPrompt,
  taskGoal,
} from './prompts.js';
import { parseVerdict, reviewFeedback, reviewPrompt } from './review.js';
import type { SessionOutcome } from './runner.js';
import type { Store } from './store.js';
import { headCommit, mergeBase, porcelainStatus } from './worktree.js';

/** Who runs the next session of a task, what it is asked, and whether it resumes one. */
export interface SessionPlan {
  role: AgentRole;
  agentId: string;
  /** Reviewers and a single task's criteria discussion only read; everything else edits. */
  access: SessionAccess;
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
    const conflict = this.pendingMergeConflict(task.id);
    if (conflict) {
      const prompt = mergeConflictPrompt(this.goal(task), conflict.base, conflict.files);
      return this.implement(task, prompt);
    }
    if (this.needsDesign(task)) return this.designPlan(task);
    // The designer's session is not the implementer's to continue.
    if (!last || last.role === 'design') return this.implement(task, this.firstPrompt(task));
    const feedback = this.inPlanning(task) ? this.pendingPlanFeedback(task.id) : null;
    if (feedback !== null) return this.revisePlan(task, feedback, last);
    if (this.justApproved(task)) return this.startAfterDiscussion(task, last);
    if (last.endReason === 'handoff' || last.endReason === 'context_hard_limit') {
      return this.continuation(task, this.handoffNote(task));
    }
    // Each loop feature starts from a clean context; its state lives in the worktree files.
    const loopStepDone = task.mode === 'loop' && last.endReason === 'completed';
    // A session that never reached the model was never saved by the CLI, so it can't be resumed.
    const resumable = !loopStepDone && this.canResume(task, last, this.activeAgent(task));
    if (resumable) return this.implement(task, QUOTA_RESUME_PROMPT, last);
    return this.continuation(task, task.mode === 'single' ? this.handoffNote(task) : null);
  }

  /** Agent profile of the task's next session, for per-provider quota checks. */
  nextAgentId(task: Task): string {
    const reviewer = task.agents.reviewer;
    if (reviewer && this.pendingReview(task.id)) return reviewer;
    if (this.needsDesign(task)) return task.agents.design!;
    return this.activeAgent(task);
  }

  private reviewPlan(task: Task, request: ReviewRequest, last: Session | undefined): SessionPlan {
    const reviewer = task.agents.reviewer!;
    const resumable =
      last?.role === 'reviewer' &&
      last.endReason !== 'completed' &&
      last.agentSessionId !== null &&
      last.contextTokens > 0 &&
      this.hasBudget(task, last);
    const base = { role: 'reviewer', agentId: reviewer, access: 'readOnly' } as const;
    if (resumable) return { ...base, resume: last, prompt: QUOTA_RESUME_PROMPT };
    const verify = task.mode === 'loop' ? (this.snapshots(task.id).at(-1)?.verify ?? null) : null;
    return {
      ...base,
      resume: null,
      prompt: reviewPrompt(this.goal(task), request, verify, task.acceptance !== null),
    };
  }

  /** The phase a planned session works in. */
  phaseOf(task: Task, plan: SessionPlan): TaskActivity {
    if (plan.role === 'reviewer') return { phase: 'reviewing', agentId: plan.agentId };
    if (plan.role === 'design') return { phase: 'designing', agentId: plan.agentId };
    // Planning lasts until the plan is approved, including revisions after feedback.
    const planning =
      this.inPlanning(task) ||
      (task.mode === 'loop' && !existsSync(path.join(task.worktreePath!, FEATURE_LIST_FILE)));
    return { phase: planning ? 'planning' : 'implementing', agentId: plan.agentId };
  }

  /** Conflicts from a merge the harness started that no session has worked on yet. */
  private pendingMergeConflict(taskId: number): MergeConflict | null {
    const event = this.host.store.lastEvent(taskId, 'merge_conflict');
    if (!event || this.host.store.hasSessionEventsAfter(taskId, event.id)) return null;
    return event.data as MergeConflict;
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

  /** The spec author's session while criteria are discussed, the implementer's otherwise. */
  private implement(task: Task, prompt: string, resume: Session | null = null): SessionPlan {
    if (this.discussing(task)) {
      const agentId = roleAgent(task.agents, 'spec')!;
      return { role: 'spec', agentId, access: 'readOnly', resume, prompt };
    }
    const agentId = task.agents.implementer;
    return { role: 'implementer', agentId, access: 'edit', resume, prompt };
  }

  /** The agent that works on the task when no review is pending. */
  private activeAgent(task: Task): string {
    return roleAgent(task.agents, this.discussing(task) ? 'spec' : 'implementer')!;
  }

  /**
   * `last` can be continued by `agentId`: it is that agent's own conversation (not a
   * reviewer's), it reached the model, and it still has context budget. The discussion and
   * the implementation share a conversation only when one agent plays both roles.
   */
  private canResume(task: Task, last: Session, agentId: string): boolean {
    return (
      (last.role === 'implementer' || last.role === 'spec') &&
      last.agentId === agentId &&
      last.agentSessionId !== null &&
      last.contextTokens > 0 &&
      this.hasBudget(task, last)
    );
  }

  /** The task as the agents are given it: the request plus any agreed criteria and design. */
  private goal(task: Task): string {
    const design = this.host.store.lastEvent(task.id, 'design')?.data as DesignNote | undefined;
    return taskGoal(task.prompt, task.acceptance, design?.text ?? null);
  }

  /** A single task with a designer, past its spec discussion, that has no design note yet. */
  private needsDesign(task: Task): boolean {
    return (
      task.mode === 'single' &&
      !!task.agents.design &&
      !this.discussing(task) &&
      !this.host.store.lastEvent(task.id, 'design')
    );
  }

  private designPlan(task: Task): SessionPlan {
    return {
      role: 'design',
      agentId: task.agents.design!,
      access: 'readOnly',
      resume: null,
      prompt: designPrompt(this.goal(task)),
    };
  }

  private firstPrompt(task: Task): string {
    if (task.mode === 'loop') return initializerPrompt(this.goal(task), task.verifyCommand);
    return this.discussing(task) ? criteriaPrompt(task.prompt, task.acceptance) : this.goal(task);
  }

  /**
   * Before the plan is approved: a loop task's feature list (or until it was accepted
   * without approval), or a single task's acceptance criteria when it discusses them first.
   */
  private inPlanning(task: Task): boolean {
    if (task.mode === 'loop') return this.snapshots(task.id).length === 0;
    return this.discussing(task);
  }

  /** A single task agreeing on acceptance criteria with the user; it may not edit yet. */
  private discussing(task: Task): boolean {
    return (
      task.mode === 'single' &&
      task.confirmPlan &&
      !this.host.store.lastEvent(task.id, 'criteria_approved')
    );
  }

  /**
   * The criteria were approved and no session has run since, so `last` was the discussion.
   * A resumed session keeps its record, so this is told by events rather than sessions.
   */
  private justApproved(task: Task): boolean {
    if (task.mode !== 'single') return false;
    const approval = this.host.store.lastEvent(task.id, 'criteria_approved');
    return !!approval && !this.host.store.hasSessionEventsAfter(task.id, approval.id);
  }

  /**
   * Continues the discussion's conversation, which already knows the repository, now
   * allowed to edit; starts afresh with the agreed goal when that is not possible.
   */
  private startAfterDiscussion(task: Task, last: Session): SessionPlan {
    const resumable = this.canResume(task, last, task.agents.implementer);
    if (resumable) return this.implement(task, criteriaApprovedPrompt(task.acceptance!), last);
    return this.implement(task, this.goal(task));
  }

  /** The user's reply to the latest proposal, if the planner has not seen it yet. */
  pendingPlanFeedback(taskId: number): string | null {
    const feedback = this.host.store.lastEvent(taskId, 'plan_feedback');
    const proposals = [
      this.host.store.lastEvent(taskId, 'plan'),
      this.host.store.lastEvent(taskId, 'criteria'),
    ];
    if (!feedback || proposals.some((p) => p && p.id > feedback.id)) return null;
    return (feedback.data as { message: string }).message;
  }

  /** Latest proposed criteria of a single task, until the user approves them. */
  criteriaProposal(task: Task): CriteriaProposal | null {
    if (!this.discussing(task)) return null;
    const stored = this.host.store.lastEvent(task.id, 'criteria')?.data as
      CriteriaProposal | undefined;
    // Proposals stored before questions were parsed have none.
    return stored ? { ...stored, questions: toQuestions(stored.questions) } : null;
  }

  /**
   * Continues the planner's own conversation with the user's reply, so it keeps everything
   * it already discussed; starts over from the plan files only when that is not possible.
   */
  private revisePlan(task: Task, message: string, last: Session): SessionPlan {
    const resumable = this.canResume(task, last, this.activeAgent(task));
    const revision =
      task.mode === 'loop' ? planRevisionPrompt(message) : criteriaRevisionPrompt(message);
    if (resumable) return this.implement(task, revision, last);
    return this.implement(task, continuationPrompt(this.firstPrompt(task), null, revision));
  }

  private continuation(task: Task, note: string | null): SessionPlan {
    const feedback = this.openFeedback(task.id);
    if (task.mode === 'single') {
      if (this.discussing(task)) {
        return this.implement(task, continuationPrompt(this.firstPrompt(task), note));
      }
      return this.implement(task, continuationPrompt(this.goal(task), note, feedback));
    }
    // Until the plan is approved, a follow-up session keeps planning, never builds.
    if (this.inPlanning(task) || !existsSync(path.join(task.worktreePath!, FEATURE_LIST_FILE))) {
      return this.implement(task, continuationPrompt(this.firstPrompt(task), note));
    }
    const verify = this.snapshots(task.id).at(-1)?.verify;
    const failed = verify && !verify.ok ? verify : null;
    return this.implement(
      task,
      loopSessionPrompt(this.goal(task), task.verifyCommand!, failed, note, feedback),
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
    if (plan.role === 'design') {
      this.finishDesign(task, outcome);
      return;
    }
    switch (outcome.reason) {
      case 'completed':
        if (this.discussing(task)) this.proposeCriteria(task, outcome.finalText);
        else if (task.mode === 'loop') await this.finishLoopStep(task, signal, outcome.finalText);
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

  /** Keeps the designer's reply for the sessions after it; the task then goes on unasked. */
  private finishDesign(task: Task, outcome: SessionOutcome): void {
    if (outcome.reason !== 'completed') {
      if (outcome.reason === 'handoff' || outcome.reason === 'context_hard_limit') {
        this.host.notice(task.id, 'the designer ran out of context before it finished');
        this.host.setStatus(task.id, 'failed');
      } else {
        this.interrupted(task, outcome);
      }
      return;
    }
    const text = outcome.finalText.trim();
    if (!text) {
      this.host.notice(task.id, 'the designer finished without writing a design');
      this.host.setStatus(task.id, 'failed');
      return;
    }
    const note: DesignNote = { text };
    this.host.store.appendEvent(task.id, null, 'design', note);
    this.host.notice(task.id, `design note written by ${task.agents.design}`);
    this.host.setStatus(task.id, 'queued');
  }

  /** Nothing is changed until the user approves the criteria or replies to them. */
  private proposeCriteria(task: Task, reply: string): void {
    const proposal: CriteriaProposal = {
      criteria: parseCriteria(reply),
      reply,
      questions: parseQuestions(reply),
    };
    this.host.store.appendEvent(task.id, null, 'criteria', proposal);
    this.host.notice(
      task.id,
      proposal.criteria
        ? 'acceptance criteria proposed; waiting for your approval'
        : 'no acceptance criteria section in the reply; reply to the agent or write them yourself',
    );
    this.host.setStatus(task.id, 'awaiting_approval');
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
