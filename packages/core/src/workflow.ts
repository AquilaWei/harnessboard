// SPDX-License-Identifier: Apache-2.0
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  FEATURE_LIST_FILE,
  PROGRESS_FILE,
  contextPct,
  resolveThresholds,
  roleAgent,
  toQuestions,
} from '@harnessboard/shared';
import type {
  AgentRole,
  CommitSpan,
  CriteriaProposal,
  FeatureSnapshot,
  MergeConflict,
  PlanProposal,
  ReviewRecord,
  RoleNote,
  SpecChangeDecision,
  SpecChangeProposal,
  SpecDelivery,
  SpecRecord,
  SpecRevisionRecord,
  SpecRevisionRequest,
  ReviewRequest,
  TestReport,
  TestRequest,
  Session,
  StoredEvent,
  Task,
  TaskActivity,
  TaskStatus,
} from '@harnessboard/shared';
import type { SessionAccess } from './agent.js';
import type { HarnessConfig } from './config.js';
import { checkCommits, COMMIT_RULE } from './commit-check.js';
import { readGuidelines } from './guidelines.js';
import { missingFeatures, readPlan, runVerify } from './loop.js';
import { NOTES_FILE, notesPrompt, parseNotes, renderNotes, writeNotes } from './notes.js';
import {
  QUOTA_RESUME_PROMPT,
  SCOPE_CHANGED_PROMPT,
  SPEC_CHANGE_DUTY,
  SPEC_CHANGE_REJECTED_PROMPT,
  continuationPrompt,
  criteriaApprovedPrompt,
  criteriaPrompt,
  criteriaRevisionPrompt,
  designPrompt,
  hasDesignSection,
  initializerPrompt,
  loopSessionPrompt,
  mergeConflictPrompt,
  parseCriteria,
  parseQuestions,
  parseSpecChange,
  planRevisionPrompt,
  specChangeApprovedPrompt,
  specFilePrompt,
  specRevisionPrompt,
  taskGoal,
} from './prompts.js';
import {
  isTestPath,
  parseTestVerdict,
  parseVerdict,
  reviewFeedback,
  reviewFollowUpPrompt,
  reviewPrompt,
  testFeedback,
  testFollowUpPrompt,
  testPrompt,
} from './review.js';
import type { SessionOutcome } from './runner.js';
import { reviseSpec } from './spec.js';
import type { Store } from './store.js';
import {
  changedPaths,
  commitFile,
  diffBase,
  git,
  headCommit,
  isCommitted,
  isMergedInto,
  mergeBase,
  porcelainStatus,
  spanPaths,
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
  /**
   * The `spec_revision` or `spec_change_decision` events the prompt carries; recorded with
   * {@link Workflow.started} so they count as delivered only to the session that heard them.
   */
  delivers?: number[];
  /**
   * Set when the prompt asks for a review of this request, so the harness can add the git
   * output for a reviewer that cannot run git itself; not set when a reviewer is resumed
   * with only a request to go on.
   */
  review?: ReviewRequest;
  /** Directories outside the worktree the session reads; set by the harness, see `SessionSpec`. */
  readableDirs?: string[];
  /** Fingerprint of requirements/rules, so a resumed role receives them again only when changed. */
  contextKey?: string;
  /** HEAD before this stage, for the commit handoff check. */
  commitBase?: string;
  /** Actual HEAD at this turn's start, independent of a retried commit check. */
  progressHead?: string;
}

/** What a task's next session is for, in the order {@link Workflow} picks it. */
type NextStep =
  | { kind: 'specRevision'; request: StoredEvent }
  | { kind: 'specDecision'; decisions: StoredEvent[] }
  | { kind: 'review'; request: ReviewRequest }
  | { kind: 'test'; request: TestRequest }
  | { kind: 'conflict'; conflict: MergeConflict }
  | { kind: 'specFile' }
  | { kind: 'design' }
  | { kind: 'work' };

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
   * for a new task or after an emergency handoff. Each role otherwise resumes its own
   * conversation across features and feedback, with compaction after completed turns at the context warning.
   */
  plan(task: Task): SessionPlan {
    const plan = this.nextSession(task);
    // A resumed session was already told; the discussion is with the user, not other roles.
    if (!this.keepsNotes(plan)) return plan;
    const hasNotes = this.notes(task.id).length > 0;
    const writing = plan.access === 'edit' ? [COMMIT_RULE] : [];
    const blocked = this.host.store.lastEvent(task.id, 'commit_check');
    const correction = blocked?.data as
      { ok: boolean; role: AgentRole; detail: string } | undefined;
    if (correction && !correction.ok && correction.role === plan.role)
      writing.push(correction.detail);
    if (plan.role !== 'implementer') {
      return {
        ...plan,
        prompt: [
          plan.prompt,
          ...writing,
          notesPrompt(false),
          ...(hasNotes
            ? [
                'Archived role notes are available in `.harnessboard/notes.md`. Consult them only when a specific ambiguity requires history; do not read them routinely.',
              ]
            : []),
        ].join('\n\n'),
      };
    }
    const duty = plan.role === 'implementer' && this.specFile(task.id) ? [SPEC_CHANGE_DUTY] : [];
    if (plan.resume) {
      const previous = this.host.store.lastSessionEvent(plan.resume.id, 'workflow_run');
      const notes = this.host.store
        .eventsOfKinds(task.id, ['role_note'], previous?.id ?? 0)
        .filter(
          (event) => event.data && ['reviewer', 'tester'].includes((event.data as RoleNote).role),
        )
        .map((event) => ({ note: event.data as RoleNote, at: event.ts }));
      const updates = notes.length > 0 ? [renderNotes(task.id, task.title, notes)] : [];
      return {
        ...plan,
        prompt: [plan.prompt, ...writing, ...duty, ...updates, notesPrompt(false)].join('\n\n'),
      };
    }
    return {
      ...plan,
      prompt: [plan.prompt, ...writing, ...duty, notesPrompt(hasNotes)].join('\n\n'),
    };
  }

  /**
   * What the task's next session is for. Both {@link nextSession} and {@link nextAgentId}
   * choose by it, so the quota checked is always that of the session that runs.
   */
  private nextStep(task: Task): NextStep {
    const conflict = this.pendingMergeConflict(task.id);
    // A merge the harness started leaves conflict markers, which come before anything else.
    if (!conflict) {
      const revision = this.pendingRevisionEvent(task.id);
      if (revision) return { kind: 'specRevision', request: revision };
      // Before the implementer starts, it hears the decided spec in its first prompt instead.
      const decisions = this.untoldDecisions(task.id);
      if (decisions.length > 0 && this.implementationStarted(task.id)) {
        return { kind: 'specDecision', decisions };
      }
    }
    const review = this.pendingReview(task.id);
    if (review) return { kind: 'review', request: review };
    const test = this.pendingTest(task.id);
    if (test) return { kind: 'test', request: test };
    if (conflict) return { kind: 'conflict', conflict };
    if (this.needsSpecFile(task)) return { kind: 'specFile' };
    if (this.needsDesign(task)) return { kind: 'design' };
    return { kind: 'work' };
  }

  private nextSession(task: Task): SessionPlan {
    const sessions = this.recentSessions(task.id);
    const last = sessions.at(-1);
    // The spec author's answers to the user and the designer's session are not the
    // implementer's work to continue.
    const work = this.withoutRevisions(task.id, sessions)
      .filter((s) => s.role !== 'designer')
      .at(-1);
    // The implementer's own conversation, which a reviewer's or tester's session did not replace.
    const own = this.withoutRevisions(task.id, sessions)
      .filter((s) => s.role === 'implementer' || s.role === 'spec')
      .at(-1);
    const step = this.nextStep(task);
    switch (step.kind) {
      case 'specRevision':
        return this.specRevisionPlan(task, step.request, last);
      case 'specDecision':
        return this.afterSpecDecision(task, step.decisions, work);
      case 'review':
        return this.reviewPlan(task, step.request, last);
      case 'test':
        return this.testPlan(task, step.request, last);
      case 'conflict': {
        const { base, files } = step.conflict;
        return this.implement(
          task,
          mergeConflictPrompt(this.goal(task), base, files),
          own && this.canResume(task, own, task.agents.implementer) ? own : null,
        );
      }
      case 'specFile':
        return this.specFilePlan(task, last);
      case 'design':
        return this.designPlan(task, last);
      case 'work':
        return this.workPlan(task, work, own);
    }
  }

  /** The implementer's (or, while criteria are discussed, the spec author's) own work. */
  private workPlan(task: Task, work: Session | undefined, own: Session | undefined): SessionPlan {
    if (!work) return this.implement(task, this.firstPrompt(task));
    const feedback = this.inPlanning(task) ? this.pendingPlanFeedback(task.id) : null;
    if (feedback !== null) return this.revisePlan(task, feedback, work);
    if (this.justSpecced(task)) return this.startAfterDiscussion(task, work);
    if (work.endReason === 'handoff' || work.endReason === 'context_hard_limit') {
      return this.continuation(task, this.handoffNote(task));
    }
    // After a review or test round, the implementer goes on in its own conversation with only
    // the findings, which keeps what it already read instead of starting over.
    const findings = work !== own ? this.openFeedback(task.id) : null;
    if (
      findings !== null &&
      own?.endReason === 'completed' &&
      this.canResume(task, own, this.activeAgent(task))
    ) {
      return this.implement(task, findings, own);
    }
    // A new feature is a new turn in the implementer's own conversation, not a new session.
    if (
      task.mode === 'loop' &&
      own?.endReason === 'completed' &&
      this.canResume(task, own, this.activeAgent(task))
    ) {
      const plan = this.continuation(task, null, true);
      return { ...plan, resume: own };
    }
    // A session that never reached the model was never saved by the CLI, so it can't be resumed.
    const resumable = this.canResume(task, work, this.activeAgent(task));
    if (resumable) return this.implement(task, QUOTA_RESUME_PROMPT, work);
    return this.continuation(task, task.mode === 'single' ? this.handoffNote(task) : null);
  }

  /** A resumed conversation keeps its original start time; scheduling follows its latest run. */
  private recentSessions(taskId: number): Session[] {
    const sessions = this.host.store.listSessions(taskId);
    const runs = this.host.store.eventsOfKind(taskId, 'workflow_run');
    const order = new Map(runs.map((event) => [event.sessionId, event.id]));
    return sessions.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  /**
   * `sessions` without the spec author's read-only answers to requests for a spec change.
   * They are told by the request each was given as it started, so one cut off before it
   * proposed anything, and then left for a newer request, is still left out.
   */
  private withoutRevisions(taskId: number, sessions: Session[]): Session[] {
    const store = this.host.store;
    const requests = new Set(store.eventsOfKind(taskId, 'spec_revision').map((e) => e.id));
    const revisions = new Set(
      store
        .eventsOfKind(taskId, 'spec_delivered')
        .filter((e) => requests.has((e.data as SpecDelivery).eventId))
        .map((e) => e.sessionId),
    );
    return sessions.filter((s) => !revisions.has(s.id));
  }

  /**
   * Agent profile of the task's next session, for per-provider quota checks. Chosen by the
   * same rules as the session itself, so a quota blocks exactly the session it would pause.
   */
  nextAgentId(task: Task): string {
    switch (this.nextStep(task).kind) {
      case 'specRevision':
      case 'specFile':
        return roleAgent(task.agents, 'spec')!;
      case 'review':
        return task.agents.reviewer!;
      case 'test':
        return task.agents.tester!;
      case 'design':
        return task.agents.designer!;
      default:
        return this.activeAgent(task);
    }
  }

  /**
   * Records that the session `sessionId` was given the request or decisions its plan
   * carries. Runs as the session starts, before the agent sees the prompt.
   */
  started(taskId: number, sessionId: string, plan: SessionPlan): void {
    this.host.store.appendEvent(taskId, sessionId, 'workflow_run', {
      role: plan.role,
      contextKey: plan.contextKey ?? null,
      commitBase: plan.commitBase ?? null,
      progressHead: plan.progressHead ?? null,
    });
    for (const eventId of plan.delivers ?? []) {
      const delivery: SpecDelivery = { eventId };
      this.host.store.appendEvent(taskId, sessionId, 'spec_delivered', delivery);
    }
    // Marks where building from the spec began; the session's role row can be the spec
    // author's when the implementer continues the discussion.
    if (
      plan.role === 'implementer' &&
      this.specFile(taskId) &&
      !this.implementationStarted(taskId)
    ) {
      this.host.store.appendEvent(taskId, sessionId, 'implementation_started', {});
    }
  }

  /**
   * The implementer began building from the committed spec: a session it was started in
   * reached the agent. A designer's, a chat's or the spec author's answer to a request for
   * a spec change does not count, nor does a launch that failed. Implementer sessions from
   * before this was recorded count when their agent reported anything after the spec.
   */
  private implementationStarted(taskId: number): boolean {
    const store = this.host.store;
    const written = store.lastEvent(taskId, 'spec_written');
    if (!written) return false;
    const marked = store
      .eventsOfKind(taskId, 'implementation_started')
      .some((e) => e.id > written.id && store.sessionHasAgentEventsAfter(e.sessionId!, e.id));
    return (
      marked ||
      store
        .listSessions(taskId)
        .some((s) => s.role === 'implementer' && store.sessionHasAgentEventsAfter(s.id, written.id))
    );
  }

  /** The `spec_delivered` events for `eventId`, oldest first. */
  private deliveries(taskId: number, eventId: number): StoredEvent[] {
    return this.host.store
      .eventsOfKind(taskId, 'spec_delivered')
      .filter((e) => (e.data as SpecDelivery).eventId === eventId);
  }

  private reviewPlan(task: Task, request: ReviewRequest, last: Session | undefined): SessionPlan {
    const reviewer = task.agents.reviewer!;
    const resumable =
      last?.role === 'reviewer' &&
      last.endReason !== 'completed' &&
      last.agentSessionId !== null &&
      this.hasConversation(last) &&
      this.hasBudget(task, last);
    const base = { role: 'reviewer', agentId: reviewer, access: 'readOnly' } as const;
    if (resumable && this.requestSeen(task.id, 'review_request', last))
      return { ...base, resume: last, prompt: QUOTA_RESUME_PROMPT };
    const goal = this.goal(task);
    const guidelines = readGuidelines(this.host.config.reviewGuidelines);
    const contextKey = this.contextKey({ goal, guidelines });
    const earlier = this.priorReviewer(task, reviewer);
    // Across rounds and features, the reviewer keeps its own conversation.
    if (earlier && this.sameContext(earlier.session, contextKey)) {
      return {
        ...base,
        resume: earlier.session,
        prompt: reviewFollowUpPrompt(
          request,
          task.workspace === 'base' ? request.since : earlier.head,
          {
            features:
              task.mode === 'loop' ? (this.snapshots(task.id).at(-1)?.features ?? null) : null,
            verify: task.mode === 'loop' ? (this.snapshots(task.id).at(-1)?.verify ?? null) : null,
          },
        ),
        review: task.workspace === 'base' ? request : { ...request, since: earlier.head },
        contextKey,
      };
    }
    const snapshot = task.mode === 'loop' ? this.snapshots(task.id).at(-1) : undefined;
    const prompt = reviewPrompt(goal, request, {
      verify: snapshot?.verify ?? null,
      hasCriteria: task.acceptance !== null,
      features: snapshot?.features ?? null,
      // Read for every review, so an edited rules file applies from the next one.
      guidelines,
    });
    // The request was rebuilt after the session stopped; it goes on with the new scope.
    if (resumable) {
      return {
        ...base,
        resume: last,
        prompt: `${SCOPE_CHANGED_PROMPT}\n\n${prompt}`,
        review: request,
        contextKey,
      };
    }
    return { ...base, resume: earlier?.session ?? null, prompt, review: request, contextKey };
  }

  /**
   * The reviewer's own finished conversation and the head it judged, across rounds and
   * features, while the conversation can continue.
   */
  private priorReviewer(task: Task, agentId: string): { session: Session; head: string } | null {
    const record = this.host.store.lastEvent(task.id, 'review')?.data as ReviewRecord | undefined;
    const session = this.recentSessions(task.id).findLast((s) => s.role === 'reviewer');
    if (
      !record ||
      !session ||
      session.agentId !== agentId ||
      session.endReason !== 'completed' ||
      session.agentSessionId === null ||
      !this.hasConversation(session) ||
      !this.hasBudget(task, session)
    ) {
      return null;
    }
    return { session, head: record.head };
  }

  /** The phase a planned session works in. */
  phaseOf(task: Task, plan: SessionPlan): TaskActivity {
    if (plan.role === 'reviewer') return { phase: 'reviewing', agentId: plan.agentId };
    if (plan.role === 'spec' && plan.access === 'edit') {
      return { phase: 'writingSpec', agentId: plan.agentId };
    }
    if (plan.role === 'tester') return { phase: 'testing', agentId: plan.agentId };
    if (plan.role === 'designer') return { phase: 'designing', agentId: plan.agentId };
    // Planning lasts until the plan is approved, including revisions after feedback, and
    // covers the spec author answering a request to change the spec.
    const planning =
      plan.role === 'spec' ||
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
      this.hasConversation(last) &&
      this.hasBudget(task, last);
    const base = { role: 'tester', agentId: tester, access: 'edit' } as const;
    if (resumable && this.requestSeen(task.id, 'test_request', last))
      return { ...base, resume: last, prompt: QUOTA_RESUME_PROMPT };
    const goal = this.goal(task);
    const contextKey = this.contextKey({ goal, verify: task.verifyCommand });
    const prompt = testPrompt(
      goal,
      request,
      task.verifyCommand,
      task.acceptance !== null,
      this.snapshots(task.id).at(-1)?.features,
    );
    // The request was rebuilt after the session stopped; it goes on with the new scope.
    if (resumable)
      return { ...base, resume: last, prompt: `${SCOPE_CHANGED_PROMPT}\n\n${prompt}`, contextKey };
    const previous = this.recentSessions(task.id).findLast((s) => s.role === 'tester');
    const report = this.testReports(task.id).at(-1);
    if (
      previous?.endReason === 'completed' &&
      previous.agentId === tester &&
      this.hasConversation(previous) &&
      this.hasBudget(task, previous)
    ) {
      return {
        ...base,
        resume: previous,
        prompt:
          report && this.sameContext(previous, contextKey)
            ? testFollowUpPrompt(
                request,
                task.workspace === 'base' ? request.since : report.head,
                task.verifyCommand,
                this.snapshots(task.id).at(-1)?.features,
              )
            : prompt,
        contextKey,
      };
    }
    return { ...base, resume: null, prompt, contextKey };
  }

  private contextKey(context: unknown): string {
    return createHash('sha256').update(JSON.stringify(context)).digest('hex');
  }

  private sameContext(session: Session, key: string): boolean {
    const run = this.host.store.lastSessionEvent(session.id, 'workflow_run');
    return (run?.data as { contextKey?: string } | undefined)?.contextKey === key;
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
      this.hasConversation(last) &&
      this.hasBudget(task, last)
    );
  }

  private hasConversation(session: Session): boolean {
    // Codex and Gemini do not report current context; a saved thread is still resumable.
    return (
      session.agentSessionId !== null &&
      (session.contextTokens > 0 ||
        session.endReason === 'completed' ||
        this.host.config.agents[session.agentId]?.provider !== 'claude-code')
    );
  }

  /** The task as the agents are given it: the request plus any agreed criteria and spec file. */
  private goal(task: Task): string {
    return taskGoal(task.prompt, task.acceptance, this.specFile(task.id), this.designed(task.id));
  }

  private firstPrompt(task: Task): string {
    if (task.mode === 'loop')
      return initializerPrompt(this.goal(task), task.verifyCommand, task.agents.tester !== null);
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
   * The spec is committed and the implementer has not started on it, so the last work
   * session was the discussion. The designer's session and the spec author's answers to
   * requests for a spec change in between do not count.
   */
  private justSpecced(task: Task): boolean {
    return (
      task.mode === 'single' && !!this.specFile(task.id) && !this.implementationStarted(task.id)
    );
  }

  /** The designer added its UI design section to the task's spec file. */
  private designed(taskId: number): boolean {
    return !!this.host.store.lastEvent(taskId, 'design_written');
  }

  /** Repository-relative path of the committed spec, once the spec author has written it. */
  specFile(taskId: number): string | null {
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
   * A designer is set, the spec is committed, and neither the designer nor the implementer
   * has finished with it yet. A designer chosen after the implementer started is not run,
   * because the UI would already be built without its design. Requests for a spec change
   * answered while the design is unwritten leave it to run before the implementer.
   */
  private needsDesign(task: Task): boolean {
    if (!task.agents.designer || !this.specFile(task.id) || this.designed(task.id)) return false;
    return !this.implementationStarted(task.id);
  }

  /** The designer's session; one cut off by a quota, stop or error goes on where it was. */
  private designPlan(task: Task, last: Session | undefined): SessionPlan {
    const designer = task.agents.designer!;
    const resumable =
      last?.role === 'designer' &&
      last.agentId === designer &&
      last.endReason !== 'completed' &&
      last.agentSessionId !== null &&
      last.contextTokens > 0 &&
      this.hasBudget(task, last);
    const base = { role: 'designer', agentId: designer, access: 'edit' } as const;
    if (resumable) return { ...base, resume: last, prompt: QUOTA_RESUME_PROMPT };
    const prompt = designPrompt(this.specFile(task.id)!, this.goal(task));
    return { ...base, resume: null, prompt };
  }

  /**
   * Checks the designer added a UI design section to the spec file and changed nothing
   * else, commits the file itself if the designer left it uncommitted, and records it for
   * the implementer and reviewer.
   */
  private async finishDesign(
    task: Task,
    outcome: SessionOutcome,
    plan: SessionPlan,
  ): Promise<void> {
    if (outcome.reason === 'handoff' || outcome.reason === 'context_hard_limit') {
      this.host.notice(task.id, 'the designer ran out of context before writing the UI design');
      this.host.setStatus(task.id, 'failed');
      return;
    }
    if (outcome.reason !== 'completed') {
      this.interrupted(task, outcome); // the design is still unwritten, so it is asked again
      return;
    }
    const dir = task.worktreePath!;
    const spec = this.host.store.lastEvent(task.id, 'spec_written')!.data as SpecRecord;
    const stray = (await this.changedSince(task, spec.head)).filter((p) => p !== spec.path);
    if (stray.length > 0) {
      this.host.notice(
        task.id,
        `the designer changed files other than the spec: ${stray.join(', ')}; stopping for a human`,
      );
      this.host.setStatus(task.id, 'failed');
      return;
    }
    const file = path.join(dir, spec.path);
    if (!existsSync(file) || !hasDesignSection(await readFile(file, 'utf8'))) {
      this.host.notice(task.id, `the designer did not add a UI design section to ${spec.path}`);
      this.host.setStatus(task.id, 'failed');
      return;
    }
    if ((await git(dir, ['status', '--porcelain', '--', spec.path])) !== '') {
      await commitFile(dir, spec.path, `docs: add UI design to ${spec.path}`);
      this.host.notice(task.id, `the designer left ${spec.path} uncommitted; committed it`);
    }
    const record: SpecRecord = { path: spec.path, head: await headCommit(dir) };
    if (!(await this.checkHandoff(task, plan))) return;
    this.host.store.appendEvent(task.id, null, 'design_written', record);
    this.host.notice(task.id, `UI design committed in ${spec.path}`);
    this.host.setStatus(task.id, 'queued');
  }

  /**
   * Files the task changed after its own commit `since`, up to the working tree. A `base`
   * task counts only its own stretches of work in the folder, so commits another task or
   * the user made there while it let go are not blamed on it.
   */
  private async changedSince(task: Task, since: string): Promise<string[]> {
    const dir = task.worktreePath!;
    const live = task.startCommit;
    if (task.workspace !== 'base' || !live || (await isMergedInto(dir, live, since))) {
      return changedPaths(dir, since);
    }
    const closed = await this.spansAfter(dir, task, since);
    const paths = await Promise.all([
      ...closed.map((s) => spanPaths(dir, s)),
      changedPaths(dir, live),
    ]);
    return [...new Set(paths.flat())];
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
  private async finishSpecFile(
    task: Task,
    outcome: SessionOutcome,
    plan: SessionPlan,
  ): Promise<void> {
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
    const stray = (await changedPaths(dir, await mergeBase(dir, diffBase(task)))).filter(
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
      await commitFile(dir, file, 'docs: add task specification');
      this.host.notice(task.id, `the spec author left ${file} uncommitted; committed it`);
    }
    const record: SpecRecord = { path: file, head: await headCommit(dir) };
    if (!(await this.checkHandoff(task, plan))) return;
    this.host.store.appendEvent(task.id, null, 'spec_written', record);
    this.host.notice(task.id, `spec committed in ${file}`);
    this.host.setStatus(task.id, 'queued');
  }

  /**
   * Continues the discussion's conversation, which already knows the repository, now
   * allowed to edit; starts afresh with the agreed goal when that is not possible. Spec
   * changes approved before it starts are in those criteria, so they count as delivered.
   */
  private startAfterDiscussion(task: Task, last: Session): SessionPlan {
    const resumable = this.canResume(task, last, task.agents.implementer);
    const plan = resumable
      ? this.implement(
          task,
          criteriaApprovedPrompt(task.acceptance!, this.specFile(task.id), this.designed(task.id)),
          last,
        )
      : this.implement(task, this.goal(task));
    const decisions = this.untoldDecisions(task.id).map((e) => e.id);
    return decisions.length > 0 ? { ...plan, delivers: decisions } : plan;
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

  private continuation(task: Task, note: string | null, resumed = false): SessionPlan {
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
      loopSessionPrompt(
        this.goal(task),
        task.verifyCommand!,
        failed,
        note,
        feedback,
        resumed,
        task.agents.tester !== null,
      ),
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
    const thresholds = resolveThresholds(task.contextPolicy);
    const limit = thresholds.compactPct !== null ? 90 : thresholds.softPct;
    return contextPct(session.contextTokens, window) < limit;
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
    this.host.store.appendEvent(
      task.id,
      plan.resume?.id ?? this.recentSessions(task.id).at(-1)!.id,
      'workflow_end',
      { role: plan.role, reason: outcome.reason },
    );
    await this.finishSession(task, plan, outcome, signal);
    this.reviseAfterStep(task.id);
  }

  private async finishSession(
    task: Task,
    plan: SessionPlan,
    outcome: SessionOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    this.host.notice(
      task.id,
      `session ended: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`,
    );
    if (
      outcome.reason === 'completed' &&
      plan.access === 'edit' &&
      (plan.role === 'implementer' || plan.role === 'tester') &&
      !(await this.checkHandoff(task, plan))
    )
      return;
    if (outcome.reason === 'completed' && this.keepsNotes(plan)) {
      await this.recordNote(task, plan, outcome.finalText);
    }
    if (plan.role === 'reviewer') {
      await this.finishReview(task, plan, outcome);
      return;
    }
    if (plan.role === 'spec' && plan.access === 'edit') {
      await this.finishSpecFile(task, outcome, plan);
      return;
    }
    if (plan.role === 'spec' && !this.discussing(task)) {
      this.finishSpecRevision(task, outcome);
      return;
    }
    if (plan.role === 'tester') {
      await this.finishTest(task, plan, outcome);
      return;
    }
    if (plan.role === 'designer') {
      await this.finishDesign(task, outcome, plan);
      return;
    }
    switch (outcome.reason) {
      case 'completed':
        if (this.discussing(task)) this.proposeCriteria(task, outcome.finalText);
        else if (task.mode === 'loop')
          await this.finishLoopStep(task, plan, signal, outcome.finalText);
        else if (!this.proposeSpecChange(task, outcome.finalText)) await this.stepDone(task);
        return;
      case 'handoff':
      case 'context_hard_limit':
        this.handOff(task, outcome);
        return;
      default:
        this.interrupted(task, outcome);
    }
  }

  private async checkHandoff(task: Task, plan: SessionPlan): Promise<boolean> {
    if (!plan.commitBase) throw new Error('Missing stage commit baseline');
    const detail = await checkCommits(task.worktreePath!, plan.commitBase);
    this.host.store.appendEvent(task.id, null, 'commit_check', {
      role: plan.role,
      ok: detail === null,
      detail,
      since: plan.commitBase,
    });
    if (detail) {
      this.host.notice(task.id, `commit handoff blocked: ${detail}`);
      this.host.setStatus(task.id, 'failed');
    }
    return detail === null;
  }

  /** Every workflow session reports to the notes file, except the discussion with the user. */
  private keepsNotes(plan: SessionPlan): boolean {
    return !(plan.role === 'spec' && plan.access === 'readOnly');
  }

  private notes(taskId: number): { note: RoleNote; at: number }[] {
    return this.host.store
      .eventsOfKind(taskId, 'role_note')
      .map((e) => ({ note: e.data as RoleNote, at: e.ts }));
  }

  /** The task's notes file as the agents see it, rendered from the stored notes; `null` before any. */
  renderedNotes(task: Task): string | null {
    const notes = this.notes(task.id);
    return notes.length > 0 ? renderNotes(task.id, task.title, notes) : null;
  }

  /**
   * Rewrites the task's notes file from the stored notes. Runs before every session, so a
   * file an agent changed or deleted is restored before the next role reads it.
   */
  async syncNotes(task: Task): Promise<void> {
    const content = this.renderedNotes(task);
    if (task.worktreePath && content !== null) await writeNotes(task.worktreePath, content);
  }

  /** Stores what a finished session reports for the roles after it, and updates the file. */
  private async recordNote(task: Task, plan: SessionPlan, reply: string): Promise<void> {
    const verdict =
      plan.role === 'reviewer'
        ? parseVerdict(reply).verdict
        : plan.role === 'tester'
          ? parseTestVerdict(reply).verdict
          : null;
    const note: RoleNote = {
      role: plan.role,
      agentId: plan.agentId,
      verdict,
      text: parseNotes(reply),
    };
    this.host.store.appendEvent(task.id, null, 'role_note', note);
    await this.syncNotes(task);
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

  /**
   * The user's request for a spec change waiting for the spec author: the latest one, unless
   * the spec author already answered that very request. An implementer's own proposal, or
   * an answer to an earlier request, does not answer it.
   */
  pendingSpecRevision(taskId: number): SpecRevisionRequest | null {
    return (this.pendingRevisionEvent(taskId)?.data as SpecRevisionRequest | undefined) ?? null;
  }

  private pendingRevisionEvent(taskId: number): StoredEvent | undefined {
    const store = this.host.store;
    const request = store.lastEvent(taskId, 'spec_revision');
    if (!request) return undefined;
    const answered = store
      .eventsOfKind(taskId, 'spec_change')
      .some((e) => (e.data as SpecChangeProposal).requestId === request.id);
    return answered ? undefined : request;
  }

  /**
   * The proposed spec change waiting for the user, until it is approved or rejected, or
   * while a request (a reply to it, or one that came in as it was written) waits for the
   * spec author, whose answer supersedes it.
   */
  specChange(taskId: number): SpecChangeProposal | null {
    const store = this.host.store;
    const proposal = store.lastEvent(taskId, 'spec_change');
    if (!proposal || this.pendingRevisionEvent(taskId)) return null;
    const decision = store.lastEvent(taskId, 'spec_change_decision');
    if (decision && decision.id > proposal.id) return null;
    return proposal.data as SpecChangeProposal;
  }

  /**
   * Records the user's request to change the spec, or their reply to a waiting change. The
   * spec author answers it in the task's next session. A request that comes in while an
   * earlier one from review still waits keeps review as the place a rejection returns to.
   * Throws when the message is empty.
   */
  requestSpecRevision(taskId: number, message: string, status: TaskStatus): void {
    const text = message.trim();
    if (!text) throw new Error('write what should change in the spec');
    const earlier = this.pendingSpecRevision(taskId)?.status;
    const request: SpecRevisionRequest = {
      message: text,
      status: earlier === 'review' ? 'review' : status,
    };
    this.host.store.appendEvent(taskId, null, 'spec_revision', request);
    this.host.notice(taskId, 'spec change requested; the spec author will propose one');
  }

  /**
   * A request made while a session or a chat ran is answered once it ends: a task that is
   * back in review goes back to work for it, the reviewer's and tester's rounds count
   * afresh, and a rejected change returns the task to review.
   */
  reviseAfterStep(taskId: number): void {
    const request = this.pendingSpecRevision(taskId);
    if (!request || this.host.store.getTask(taskId)?.status !== 'review') return;
    const moved: SpecRevisionRequest = { ...request, status: 'review' };
    this.host.store.appendEvent(taskId, null, 'spec_revision', moved);
    this.sendBack(taskId);
    this.host.setStatus(taskId, 'queued');
  }

  /**
   * The spec author's read-only answer to the user's request. It goes on in its own session
   * when that was cut off after receiving the request; otherwise it starts afresh from the
   * spec file, which holds every decision.
   */
  private specRevisionPlan(
    task: Task,
    request: StoredEvent,
    last: Session | undefined,
  ): SessionPlan {
    const agentId = roleAgent(task.agents, 'spec')!;
    const base = { role: 'spec', agentId, access: 'readOnly' } as const;
    const cutOff =
      last?.role === 'spec' &&
      last.endReason !== 'completed' &&
      this.canResume(task, last, agentId) &&
      this.deliveries(task.id, request.id).some((e) => e.sessionId === last.id);
    if (cutOff) return { ...base, resume: last, prompt: QUOTA_RESUME_PROMPT };
    const { message } = request.data as SpecRevisionRequest;
    const pending = this.undecidedProposal(task.id);
    const prompt = specRevisionPrompt(this.goal(task), message, pending);
    return { ...base, resume: null, prompt, delivers: [request.id] };
  }

  /**
   * The criteria of the latest change the user has not decided on, which a waiting request
   * replies to or came in while it was written.
   */
  private undecidedProposal(taskId: number): string | null {
    const store = this.host.store;
    const proposal = store.lastEvent(taskId, 'spec_change');
    if (!proposal) return null;
    const decision = store.lastEvent(taskId, 'spec_change_decision');
    if (decision && decision.id > proposal.id) return null;
    const { criteria, reply } = proposal.data as SpecChangeProposal;
    return criteria ?? reply;
  }

  private finishSpecRevision(task: Task, outcome: SessionOutcome): void {
    if (outcome.reason === 'handoff' || outcome.reason === 'context_hard_limit') {
      this.host.notice(task.id, 'the spec author ran out of context before proposing a change');
      this.host.setStatus(task.id, 'failed');
      return;
    }
    if (outcome.reason !== 'completed') {
      this.interrupted(task, outcome); // the request stays pending and is answered again
      return;
    }
    // The request this session was given, not one that came in while it ran.
    const sessionId = this.host.store.listSessions(task.id).at(-1)!.id;
    const delivery = this.host.store.lastSessionEvent(sessionId, 'spec_delivered')!;
    const requestId = (delivery.data as SpecDelivery).eventId;
    const request = this.host.store
      .eventsOfKind(task.id, 'spec_revision')
      .find((e) => e.id === requestId)!.data as SpecRevisionRequest;
    const reply = outcome.finalText;
    this.propose(task, {
      from: 'user',
      reason: request.message,
      previous: task.acceptance ?? '',
      criteria: parseCriteria(reply),
      reply,
      onReject: request.status === 'review' ? 'review' : 'queued',
      sessionId,
      requestId,
    });
  }

  /** Stops for the user when the implementer of a task with a spec ends with a spec change. */
  private proposeSpecChange(task: Task, reply: string): boolean {
    if (task.mode !== 'single' || !this.specFile(task.id)) return false;
    const change = parseSpecChange(reply);
    if (!change) return false;
    this.propose(task, {
      from: 'implementer',
      reason: change.reason,
      previous: task.acceptance ?? '',
      criteria: change.criteria,
      reply,
      onReject: 'queued',
      sessionId: null,
      requestId: null,
    });
    return true;
  }

  /**
   * Stops for the user's decision, unless a request came in while the proposal was written:
   * the spec author answers that first, starting from this proposal.
   */
  private propose(task: Task, proposal: SpecChangeProposal): void {
    this.host.store.appendEvent(task.id, null, 'spec_change', proposal);
    if (this.pendingRevisionEvent(task.id)) {
      this.host.notice(
        task.id,
        'a newer spec change request is waiting; the spec author answers it next',
      );
      this.host.setStatus(task.id, 'queued');
      return;
    }
    this.host.notice(
      task.id,
      proposal.criteria
        ? `${proposal.from === 'user' ? 'the spec author' : 'the implementer'} proposed a spec change; waiting for your approval`
        : 'a spec change was proposed without revised criteria; reply or write them yourself',
    );
    this.host.setStatus(task.id, 'awaiting_approval');
  }

  /**
   * Records the user's decision on the waiting spec change. An approval also changes the
   * task's criteria; the spec file is rewritten before the next session
   * ({@link reviseSpecFile}). Throws when an approval has no criteria to approve.
   */
  decideSpecChange(task: Task, approved: boolean, criteria?: string): SpecChangeDecision {
    const proposal = this.specChange(task.id)!;
    const agreed = approved ? criteria?.trim() || proposal.criteria : proposal.previous;
    if (!agreed) throw new Error('write the revised acceptance criteria to approve');
    const decision: SpecChangeDecision = {
      approved,
      from: proposal.from,
      reason: proposal.reason,
      previous: proposal.previous,
      criteria: agreed,
    };
    this.host.store.appendEvent(task.id, null, 'spec_change_decision', decision);
    return decision;
  }

  /**
   * Every decision on a spec change the implementer has to hear and has not heard yet,
   * oldest first: each approval, and each rejection of its own proposal. A decision is
   * heard once the agent of a session given it reported anything, so a launch that failed
   * leaves it unheard though the harness logged usage for it; a chat in between tells
   * the implementer nothing, and neither does a later decision it need not hear (the
   * rejection of the user's own request), so an approval before that one stays untold.
   */
  private untoldDecisions(taskId: number): StoredEvent[] {
    const store = this.host.store;
    return store.eventsOfKind(taskId, 'spec_change_decision').filter((event) => {
      const decision = event.data as SpecChangeDecision;
      if (!decision.approved && decision.from !== 'implementer') return false;
      const heard = this.deliveries(taskId, event.id).some((e) =>
        store.sessionHasAgentEventsAfter(e.sessionId!, e.id),
      );
      return !heard;
    });
  }

  /**
   * The implementer goes on in its own conversation when it can, told what was decided:
   * the latest approval, whose criteria replace every earlier one's, and each rejection of
   * its own proposals, in the order they were made. All of `events` count as delivered.
   */
  private afterSpecDecision(
    task: Task,
    events: StoredEvent[],
    work: Session | undefined,
  ): SessionPlan {
    const approval = events.findLast((e) => (e.data as SpecChangeDecision).approved);
    const told = events
      .filter((e) => e === approval || !(e.data as SpecChangeDecision).approved)
      .map((e) => {
        const decision = e.data as SpecChangeDecision;
        return decision.approved
          ? specChangeApprovedPrompt(decision.criteria, this.specFile(task.id)!)
          : SPEC_CHANGE_REJECTED_PROMPT;
      })
      .join('\n\n');
    const plan =
      work && this.canResume(task, work, task.agents.implementer)
        ? this.implement(task, told, work)
        : this.implement(task, continuationPrompt(this.goal(task), null, told));
    return { ...plan, delivers: events.map((e) => e.id) };
  }

  /**
   * Writes the latest approved spec change into the spec file, with a dated Revisions entry,
   * and commits only that file, unless that was done already. Runs before a session, while
   * the task holds its folder. Throws when the file can not be read or git can not commit.
   */
  async reviseSpecFile(task: Task): Promise<void> {
    const store = this.host.store;
    const event = store.lastEvent(task.id, 'spec_change_decision');
    const decision = event?.data as SpecChangeDecision | undefined;
    if (!event || !decision?.approved) return;
    const done = store.lastEvent(task.id, 'spec_revised');
    if (done && done.id > event.id) return;
    const dir = task.worktreePath!;
    const file = this.specFile(task.id)!;
    const date = new Date(event.ts).toISOString().slice(0, 10);
    const full = path.join(dir, file);
    const content = await readFile(full, 'utf8');
    await writeFile(full, reviseSpec(content, decision.criteria, date, revisionSummary(decision)));
    await commitFile(dir, file, 'docs: revise task specification');
    const record: SpecRevisionRecord = { path: file, head: await headCommit(dir), date };
    store.appendEvent(task.id, null, 'spec_revised', record);
    this.host.notice(task.id, `spec revised in ${file}`);
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
    if (task.agents.tester) await this.requestTest(task);
    else await this.requestReview(task);
  }

  /**
   * What the next review or test of a step covers: from `since` to HEAD, plus a `base`
   * task's `earlier` stretches nobody approved yet. Those are listed one by one because
   * the commits between them are other work in the folder.
   */
  private async stepBase(task: Task): Promise<{ since: string; earlier: CommitSpan[] }> {
    const dir = task.worktreePath!;
    const approved = this.reviews(task.id).findLast((r) => r.verdict === 'approve');
    const base = await mergeBase(dir, diffBase(task));
    if (task.workspace !== 'base') return { since: approved?.head ?? base, earlier: [] };
    if (approved && (await isMergedInto(dir, base, approved.head))) {
      return { since: approved.head, earlier: [] };
    }
    return { since: base, earlier: await this.spansAfter(dir, task, approved?.head) };
  }

  /**
   * A `base` task's earlier stretches after its own commit `since` (all of them without
   * one), such as its last approval; the stretch `since` falls in counts from it on.
   */
  private async spansAfter(
    dir: string,
    task: Task,
    since: string | undefined,
  ): Promise<CommitSpan[]> {
    const spans = task.priorSpans.filter((span) => span.from !== span.to);
    if (!since) return spans;
    for (let i = spans.length - 1; i >= 0; i--) {
      const { from, to } = spans[i]!;
      const within = (await isMergedInto(dir, from, since)) && (await isMergedInto(dir, since, to));
      if (!within) continue;
      const rest = spans.slice(i + 1);
      return since === to ? rest : [{ from: since, to }, ...rest];
    }
    return spans;
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
    const round = this.roundsSince(task.id, 'test_report', 'pass') + 1;
    const request: TestRequest = { round, ...(await this.stepBase(task)), head, status };
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
      if (task.mode === 'loop') {
        const snapshots = this.snapshots(task.id);
        const snapshot = snapshots.at(-1)!;
        const verifiedPassing = snapshot.features.filter((feature) => feature.passes).length;
        const progressSnapshots = this.progressSnapshots(task.id);
        this.recordSnapshot(task.id, { ...snapshot, testerPassed: true, verifiedPassing });
        const limit = this.host.config.loopStallSessions;
        const recent = [
          0,
          ...progressSnapshots.filter((s) => s.testerPassed).map((s) => s.verifiedPassing),
          verifiedPassing,
        ].slice(-(limit + 1));
        const reviewFix = this.reviews(task.id).at(-1)?.verdict === 'changes';
        if (!reviewFix && recent.length === limit + 1 && recent.every((n) => n === recent[0])) {
          this.host.notice(
            task.id,
            `no verified progress in ${limit} sessions; stopping for review`,
          );
          this.host.setStatus(task.id, 'failed');
          return;
        }
      }
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

  /**
   * Rebuilds a review or test request still waiting for a `base` task that has just opened
   * a new stretch. The old one runs up to a HEAD that now includes other work in the
   * folder, which the reviewer or tester would be shown, and its baseline would blame them
   * for those commits. The round stays the same. Throws when git cannot read the folder.
   */
  async refreshPending(task: Task): Promise<void> {
    await this.rebuildPending(
      task,
      () => true,
      'other work landed in the folder; the waiting check now leaves it out',
    );
  }

  /**
   * Rebuilds a review or test request still waiting when a chat changed the folder after
   * it was made. The chat's commits join what is checked, and its edits leave the baseline,
   * so the reviewer or tester is not blamed for them. Throws when git cannot read the folder.
   */
  async refreshAfterChat(task: Task): Promise<void> {
    await this.rebuildPending(
      task,
      (request, head, status) => request.head !== head || request.status !== status,
      'a chat changed the folder; the waiting check now covers it',
    );
  }

  /** Appends a new copy of each pending request that `stale` rejects, with the same round. */
  private async rebuildPending(
    task: Task,
    stale: (request: ReviewRequest | TestRequest, head: string, status: string) => boolean,
    notice: string,
  ): Promise<void> {
    const review = this.pendingReview(task.id);
    const test = this.pendingTest(task.id);
    if (!review && !test) return;
    const dir = task.worktreePath!;
    const [head, status] = await Promise.all([headCommit(dir), porcelainStatus(dir)]);
    const staleReview = review && stale(review, head, status);
    const staleTest = test && stale(test, head, status);
    if (!staleReview && !staleTest) return;
    const scope = { ...(await this.stepBase(task)), head, status };
    const store = this.host.store;
    if (staleReview) {
      store.appendEvent(task.id, null, 'review_request', { ...scope, round: review.round });
    }
    if (staleTest) {
      store.appendEvent(task.id, null, 'test_request', { ...scope, round: test.round });
    }
    this.host.notice(task.id, notice);
  }

  /**
   * Whether `session` already received the latest request of `kind`. Other sessions' events
   * (a chat with the implementer) say nothing about it, and one rebuilt by
   * {@link refreshPending} or {@link refreshAfterChat} after it stopped is still news to it.
   */
  private requestSeen(
    taskId: number,
    kind: 'review_request' | 'test_request',
    session: Session,
  ): boolean {
    const event = this.host.store.lastEvent(taskId, kind);
    return event !== undefined && this.host.store.sessionHasEventsAfter(session.id, event.id);
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
    const round = this.roundsSince(task.id, 'review', 'approve') + 1;
    const request: ReviewRequest = { round, ...(await this.stepBase(task)), head, status };
    this.host.store.appendEvent(task.id, null, 'review_request', request);
    this.host.notice(task.id, `sent for review to ${task.agents.reviewer} (round ${round})`);
    this.host.setStatus(task.id, 'queued');
  }

  /**
   * Records that a human sent a task in review back to work. The reviewer's and tester's
   * rounds count again from here, so the task does not stop after a single further step.
   */
  sendBack(taskId: number): void {
    this.host.store.appendEvent(taskId, null, 'sent_back', {});
    this.resetImplementerProgress(taskId);
  }

  /**
   * Reviews (or test reports) since the step last passed or a human sent the task back;
   * these are the rounds counted against `maxReviewRounds`.
   */
  private roundsSince(taskId: number, kind: 'review' | 'test_report', passed: string): number {
    const store = this.host.store;
    const records = store.eventsOfKind(taskId, kind);
    const passedAt = records.findLast((e) => (e.data as { verdict: string }).verdict === passed);
    const start = Math.max(passedAt?.id ?? 0, store.lastEvent(taskId, 'sent_back')?.id ?? 0);
    return records.filter((e) => e.id > start).length;
  }

  /** Where an approved (or unreviewed) step leads: the next loop feature or human review. */
  private afterApproval(task: Task): void {
    if (task.mode === 'single') {
      this.host.setStatus(task.id, 'review');
      return;
    }
    const last = this.snapshots(task.id).at(-1);
    const done = (last?.verify?.ok || last?.testerPassed) && last.features.every((f) => f.passes);
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
   * After a loop session: checks the feature list and sends formal verification to the
   * tester, or runs the verify command itself when no tester is configured.
   */
  private async finishLoopStep(
    task: Task,
    sessionPlan: SessionPlan,
    signal: AbortSignal,
    reply: string,
  ): Promise<void> {
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

    // Check before cached test/review results can send this task around the loop again.
    if (
      await this.stopUnchangedImplementer(
        task,
        sessionPlan,
        reply,
        features.every((f) => f.passes),
      )
    )
      return;

    if (task.agents.tester) {
      this.recordSnapshot(task.id, {
        features,
        verify: null,
        verifiedPassing: snapshots.at(-1)!.verifiedPassing,
      });
      await this.stepDone(task);
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
    const progressSnapshots = this.progressSnapshots(task.id);
    this.recordSnapshot(task.id, { features, verify, verifiedPassing });
    this.host.notice(
      task.id,
      verify.ok
        ? `verify passed: ${claimed}/${features.length} features done`
        : `verify failed (${verify.timedOut ? 'timed out' : `exit ${verify.exitCode}`})`,
    );

    // Fixing review feedback is expected to add no new features, so it is not a stall.
    const limit = this.host.config.loopStallSessions;
    const recent = [...progressSnapshots.map((s) => s.verifiedPassing), verifiedPassing].slice(
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

  /** User retries begin a new progress window; automatic scheduling never resets it. */
  resetImplementerProgress(taskId: number): void {
    if (this.host.store.lastEvent(taskId, 'implementer_progress')) {
      this.host.store.appendEvent(taskId, null, 'implementer_progress_reset', {});
    }
  }

  /** Persist per-turn progress independently of provider sessions and cached verdicts. */
  private async stopUnchangedImplementer(
    task: Task,
    plan: SessionPlan,
    reply: string,
    completionPending: boolean,
  ): Promise<boolean> {
    if (!plan.progressHead) throw new Error('Missing implementer progress baseline');
    const store = this.host.store;
    const previousEvent = store.lastEvent(task.id, 'implementer_progress');
    const reset = store.lastEvent(task.id, 'implementer_progress_reset')?.id ?? 0;
    const previous =
      previousEvent && previousEvent.id > reset
        ? (previousEvent.data as { unchangedTurns: number; verifiedPassing: number })
        : undefined;
    const verifiedPassing = this.snapshots(task.id).at(-1)!.verifiedPassing;
    const paths = await changedPaths(task.worktreePath!, plan.progressHead);
    const changed = paths.some(
      (file) => file !== FEATURE_LIST_FILE && file !== PROGRESS_FILE && file !== NOTES_FILE,
    );
    const priorTurns =
      verifiedPassing > (previous?.verifiedPassing ?? 0) ? 0 : (previous?.unchangedTurns ?? 0);
    const unchangedTurns = changed ? 0 : priorTurns + 1;
    store.appendEvent(task.id, null, 'implementer_progress', {
      unchangedTurns,
      verifiedPassing,
      startHead: plan.progressHead,
      endHead: await headCommit(task.worktreePath!),
    });
    // Let a final feature claim reach verification; failed checks retain their own retry limits.
    const finalClaim = completionPending && paths.includes(FEATURE_LIST_FILE);
    if (finalClaim || unchangedTurns < this.host.config.loopStallSessions) return false;
    this.host.notice(
      task.id,
      `no implementation progress in ${unchangedTurns} implementer turns; paused for review. ` +
        `Resolve the blocker and send the task back to work to reset the counter. ` +
        `Last reply: ${reply.slice(0, 1000)}`,
    );
    this.host.setStatus(task.id, 'review');
    return true;
  }

  /** Historical baselines remain available, but a human retry starts fresh stall counts. */
  private progressSnapshots(taskId: number): FeatureSnapshot[] {
    const reset = this.host.store.lastEvent(taskId, 'implementer_progress_reset')?.id ?? 0;
    return this.host.store
      .eventsOfKind(taskId, 'features')
      .filter((event) => event.id > reset)
      .map((event) => event.data as FeatureSnapshot);
  }

  private recordSnapshot(taskId: number, snapshot: FeatureSnapshot): void {
    this.host.store.appendEvent(taskId, null, 'features', snapshot);
  }

  private handOff(task: Task, outcome: SessionOutcome): void {
    const note = outcome.reason === 'handoff' && outcome.finalText ? outcome.finalText : null;
    this.host.store.appendEvent(task.id, null, 'handoff', { note });
    // A reused session's endReason changes each turn, so count immutable run outcomes.
    const ends = this.host.store.eventsOfKind(task.id, 'workflow_end');
    const sinceCompleted = ends.slice(
      ends.findLastIndex((event) => (event.data as { reason: string }).reason === 'completed') + 1,
    );
    const handoffs = sinceCompleted.filter((event) => {
      const { reason } = event.data as { reason: string };
      return reason === 'handoff' || reason === 'context_hard_limit';
    }).length;
    if (handoffs >= this.host.config.maxHandoffs) {
      this.host.notice(task.id, `reached ${handoffs} handoffs (maxHandoffs); stopping for review`);
      this.host.setStatus(task.id, 'failed');
      return;
    }
    this.host.setStatus(task.id, 'queued');
  }
}

/** The Revisions entry of an approved change: who asked and why, on one line. */
function revisionSummary(decision: SpecChangeDecision): string {
  const why = decision.reason.split('\n')[0]!.trim().slice(0, 200);
  const who =
    decision.from === 'user'
      ? "acceptance criteria changed at the user's request"
      : 'acceptance criteria changed as the implementer proposed, approved by the user';
  return why ? `${who}: ${why}` : who;
}
