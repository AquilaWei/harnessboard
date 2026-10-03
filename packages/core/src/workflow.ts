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
  FeatureSnapshot,
  MergeConflict,
  PlanProposal,
  ReviewRecord,
  SpecRecord,
  ReviewRequest,
  TestReport,
  TestRequest,
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
  initializerPrompt,
  loopSessionPrompt,
  mergeConflictPrompt,
  parseCriteria,
  parseQuestions,
  planRevisionPrompt,
  specFilePrompt,
  taskGoal,
} from './prompts.js';
import {
  isTestPath,
  parseTestVerdict,
  parseVerdict,
  reviewFeedback,
  reviewPrompt,
  testFeedback,
  testPrompt,
} from './review.js';
import type { SessionOutcome } from './runner.js';
import type { Store } from './store.js';
import {
  changedPaths,
  commitFile,
  headCommit,
  isCommitted,
  mergeBase,
  porcelainStatus,
} from './worktree.js';

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
    const testing = this.pendingTest(task.id);
    if (testing) return this.testPlan(task, testing, last);
    const conflict = this.pendingMergeConflict(task.id);
    if (conflict) {
      const prompt = mergeConflictPrompt(this.goal(task), conflict.base, conflict.files);
      return this.implement(task, prompt);
    }
    if (this.needsSpecFile(task)) return this.specFilePlan(task, last);
    if (!last) return this.implement(task, this.firstPrompt(task));
    const feedback = this.inPlanning(task) ? this.pendingPlanFeedback(task.id) : null;
    if (feedback !== null) return this.revisePlan(task, feedback, last);
    if (this.justSpecced(task)) return this.startAfterDiscussion(task, last);
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
    if (task.agents.tester && this.pendingTest(task.id)) return task.agents.tester;
    if (this.needsSpecFile(task)) return roleAgent(task.agents, 'spec')!;
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
    if (plan.role === 'spec' && plan.access === 'edit') {
      return { phase: 'writingSpec', agentId: plan.agentId };
    }
    if (plan.role === 'tester') return { phase: 'testing', agentId: plan.agentId };
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

  /** The test run waiting to happen: the latest step was sent to the tester and not yet tested. */
  pendingTest(taskId: number): TestRequest | null {
    const request = this.host.store.lastEvent(taskId, 'test_request');
    const report = this.host.store.lastEvent(taskId, 'test_report');
    if (!request || (report && report.id > request.id)) return null;
    return request.data as TestRequest;
  }

  private testPlan(task: Task, request: TestRequest, last: Session | undefined): SessionPlan {
    const tester = task.agents.tester!;
    const resumable =
      last?.role === 'tester' &&
      last.endReason !== 'completed' &&
      last.agentSessionId !== null &&
      last.contextTokens > 0 &&
      this.hasBudget(task, last);
    const base = { role: 'tester', agentId: tester, access: 'edit' } as const;
    if (resumable) return { ...base, resume: last, prompt: QUOTA_RESUME_PROMPT };
    const prompt = testPrompt(
      this.goal(task),
      request,
      task.verifyCommand,
      task.acceptance !== null,
    );
    return { ...base, resume: null, prompt };
  }

  /**
   * What the implementer still has to fix: the latest review that asked for changes or test
   * report that failed, unless a newer step was already sent to that reviewer or tester.
   */
  private openFeedback(taskId: number): string | null {
    const store = this.host.store;
    const open: { id: number; text: string }[] = [];
    const review = store.lastEvent(taskId, 'review');
    const request = store.lastEvent(taskId, 'review_request');
    if (review && !(request && request.id > review.id)) {
      const record = review.data as ReviewRecord;
      if (record.verdict === 'changes') open.push({ id: review.id, text: reviewFeedback(record) });
    }
    const report = store.lastEvent(taskId, 'test_report');
    const testRequest = store.lastEvent(taskId, 'test_request');
    if (report && !(testRequest && testRequest.id > report.id)) {
      const record = report.data as TestReport;
      if (record.verdict === 'fail') open.push({ id: report.id, text: testFeedback(record) });
    }
    return open.sort((a, b) => b.id - a.id)[0]?.text ?? null;
  }

  private testReports(taskId: number): TestReport[] {
    return this.host.store.eventsOfKind(taskId, 'test_report').map((e) => e.data as TestReport);
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

  /** The task as the agents are given it: the request plus any agreed criteria and spec file. */
  private goal(task: Task): string {
    return taskGoal(task.prompt, task.acceptance, this.specFile(task.id));
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
  private justSpecced(task: Task): boolean {
    if (task.mode !== 'single') return false;
    const written = this.host.store.lastEvent(task.id, 'spec_written');
    return !!written && !this.host.store.hasSessionEventsAfter(task.id, written.id);
  }

  /** Repository-relative path of the committed spec, once the spec author has written it. */
  private specFile(taskId: number): string | null {
    const written = this.host.store.lastEvent(taskId, 'spec_written')?.data as
      SpecRecord | undefined;
    return written?.path ?? null;
  }

  /** Where a task's spec is written: `docs/specs/<id>-<title>.md`. */
  specPath(task: Task): string {
    const slug = task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)
      .replace(/-$/, '');
    return `docs/specs/${String(task.id).padStart(3, '0')}-${slug || 'task'}.md`;
  }

  /** The criteria were approved after a discussion, and the spec is not in the repository yet. */
  private needsSpecFile(task: Task): boolean {
    return (
      task.mode === 'single' &&
      !!this.host.store.lastEvent(task.id, 'criteria_approved') &&
      !this.host.store.lastEvent(task.id, 'spec_written')
    );
  }

  /**
   * The spec author writes the agreed spec to a file and commits it. It continues the
   * discussion when it can, because that conversation holds every decision.
   */
  private specFilePlan(task: Task, last: Session | undefined): SessionPlan {
    const agentId = roleAgent(task.agents, 'spec')!;
    const resume = last && this.canResume(task, last, agentId) ? last : null;
    const proposal = this.host.store.lastEvent(task.id, 'criteria')?.data as
      CriteriaProposal | undefined;
    // A session cut off while writing continues; the finished discussion is asked to write.
    const prompt =
      resume && resume.endReason !== 'completed'
        ? QUOTA_RESUME_PROMPT
        : specFilePrompt(
            this.specPath(task),
            task.prompt,
            task.acceptance ?? '',
            resume ? null : (proposal?.reply ?? null),
          );
    return { role: 'spec', agentId, access: 'edit', resume, prompt };
  }

  /**
   * Checks the spec author wrote the file and nothing else, commits the file itself if the
   * author left it uncommitted, and records it for the agents after it.
   */
  private async finishSpecFile(task: Task, outcome: SessionOutcome): Promise<void> {
    if (outcome.reason === 'handoff' || outcome.reason === 'context_hard_limit') {
      this.host.notice(task.id, 'the spec author ran out of context before writing the spec');
      this.host.setStatus(task.id, 'failed');
      return;
    }
    if (outcome.reason !== 'completed') {
      this.interrupted(task, outcome); // the spec is still unwritten, so it is asked again
      return;
    }
    const dir = task.worktreePath!;
    const file = this.specPath(task);
    const stray = (await changedPaths(dir, await mergeBase(dir, task.baseRef))).filter(
      (p) => p !== file,
    );
    if (stray.length > 0) {
      this.host.notice(
        task.id,
        `the spec author changed files other than the spec: ${stray.join(', ')}; stopping for a human`,
      );
      this.host.setStatus(task.id, 'failed');
      return;
    }
    if (!existsSync(path.join(dir, file))) {
      this.host.notice(task.id, `the spec author did not write ${file}`);
      this.host.setStatus(task.id, 'failed');
      return;
    }
    if (!(await isCommitted(dir, file))) {
      await commitFile(dir, file, `docs: add spec for ${task.title.slice(0, 50)}`);
      this.host.notice(task.id, `the spec author left ${file} uncommitted; committed it`);
    }
    const record: SpecRecord = { path: file, head: await headCommit(dir) };
    this.host.store.appendEvent(task.id, null, 'spec_written', record);
    this.host.notice(task.id, `spec committed in ${file}`);
    this.host.setStatus(task.id, 'queued');
  }

  /**
   * Continues the discussion's conversation, which already knows the repository, now
   * allowed to edit; starts afresh with the agreed goal when that is not possible.
   */
  private startAfterDiscussion(task: Task, last: Session): SessionPlan {
    const resumable = this.canResume(task, last, task.agents.implementer);
    if (resumable)
      return this.implement(
        task,
        criteriaApprovedPrompt(task.acceptance!, this.specFile(task.id)),
        last,
      );
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
    if (plan.role === 'spec' && plan.access === 'edit') {
      await this.finishSpecFile(task, outcome);
      return;
    }
    if (plan.role === 'tester') {
      await this.finishTest(task, plan, outcome);
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
    if (task.agents.tester && task.mode === 'single') await this.requestTest(task);
    else await this.requestReview(task);
  }

  /** Commit the next review or test of a step is measured from. */
  private async stepBase(task: Task): Promise<string> {
    const approved = this.reviews(task.id).findLast((r) => r.verdict === 'approve');
    return approved?.head ?? (await mergeBase(task.worktreePath!, task.baseRef));
  }

  /**
   * Sends the finished step to the tester. A step the tester already passed goes straight
   * on; one it failed and the implementer did not change goes to a human.
   */
  private async requestTest(task: Task): Promise<void> {
    const dir = task.worktreePath!;
    const [head, status] = await Promise.all([headCommit(dir), porcelainStatus(dir)]);
    const reports = this.testReports(task.id);
    const last = reports.at(-1);
    if (last && last.head === head && status === '') {
      if (last.verdict === 'pass') {
        await this.requestReview(task);
      } else {
        this.host.notice(task.id, 'no new commits since the tester reported failures');
        this.host.setStatus(task.id, 'review');
      }
      return;
    }
    const passedAt = reports.findLastIndex((r) => r.verdict === 'pass');
    const round = reports.slice(passedAt + 1).length + 1;
    const request: TestRequest = { round, since: await this.stepBase(task), head, status };
    this.host.store.appendEvent(task.id, null, 'test_request', request);
    this.host.notice(task.id, `sent to ${task.agents.tester} for testing (round ${round})`);
    this.host.setStatus(task.id, 'queued');
  }

  private async finishTest(task: Task, plan: SessionPlan, outcome: SessionOutcome): Promise<void> {
    const request = this.pendingTest(task.id)!;
    const record = (verdict: TestReport['verdict'], findings: string, head: string) =>
      this.host.store.appendEvent(task.id, null, 'test_report', {
        round: request.round,
        agentId: plan.agentId,
        verdict,
        findings,
        head,
      } satisfies TestReport);

    if (outcome.reason === 'context_hard_limit' || outcome.reason === 'handoff') {
      record(null, 'The tester ran out of context before giving a verdict.', request.head);
      this.host.notice(task.id, 'tester ran out of context; needs a human');
      this.host.setStatus(task.id, 'review');
      return;
    }
    if (outcome.reason !== 'completed') {
      this.interrupted(task, outcome); // the test run stays pending and starts again
      return;
    }
    const dir = task.worktreePath!;
    const head = await headCommit(dir);
    const stray = await this.nonTestChanges(dir, request);
    if (stray.length > 0) {
      record(null, `The tester changed files that are not tests: ${stray.join(', ')}`, head);
      this.host.notice(task.id, 'tester changed more than tests; stopping for a human');
      this.host.setStatus(task.id, 'failed');
      return;
    }
    const { verdict, findings } = parseTestVerdict(outcome.finalText);
    record(verdict, findings, head);
    if (verdict === 'pass') {
      this.host.notice(task.id, `${plan.agentId} passed round ${request.round}`);
      await this.requestReview(task);
    } else if (verdict === null) {
      this.host.notice(task.id, 'tester gave no verdict line; needs a human');
      this.host.setStatus(task.id, 'review');
    } else if (request.round >= task.agents.maxReviewRounds) {
      this.host.notice(
        task.id,
        `${plan.agentId} still reports failures after ${request.round} rounds; needs a human`,
      );
      this.host.setStatus(task.id, 'review');
    } else {
      this.host.notice(task.id, `${plan.agentId} reported failures (round ${request.round})`);
      this.host.setStatus(task.id, 'queued');
    }
  }

  /** Files the tester changed that are not tests; what was already changed at the request is not its doing. */
  private async nonTestChanges(dir: string, request: TestRequest): Promise<string[]> {
    return this.changesOutside(dir, request, isTestPath);
  }

  /** Files changed since the request that `allowed` does not accept. */
  private async changesOutside(
    dir: string,
    request: { head: string; status: string },
    allowed: (file: string) => boolean,
  ): Promise<string[]> {
    const before = new Set(
      request.status
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.slice(3).trim()),
    );
    const changed = await changedPaths(dir, request.head);
    return changed.filter((file) => !before.has(file) && !allowed(file));
  }

  /** Sends new commits to the reviewer, or moves on when there is none. */
  private async requestReview(task: Task): Promise<void> {
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
    const since = await this.stepBase(task);
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
