// SPDX-License-Identifier: Apache-2.0
import type {
  CommitSpan,
  CriteriaApproval,
  CriteriaProposal,
  MergeConflict,
  MergeRecord,
  Session,
  SessionEndReason,
  TaskStatus,
} from './task.js';
import type { FeatureSnapshot, PlanApproval, PlanProposal } from './loop.js';
import type { PermissionDecisionRecord, PermissionRequest } from './permissions.js';
import type { AgentRole } from './agents.js';

export type Verdict = 'approve' | 'changes';

/**
 * Stored as the `review_request` event when an implementer step is ready for review.
 * `head` and `status` record the worktree the reviewer is given, so any change it makes
 * can be detected.
 */
export interface ReviewRequest {
  round: number;
  /** Commit the reviewer diffs against: the last approved head, or the task's base. */
  since: string;
  /**
   * A `base` task's earlier stretches of its own work still to check, oldest first; the
   * commits between them are other work in the folder. Missing in requests stored before.
   */
  earlier?: CommitSpan[];
  head: string;
  /** `git status --porcelain` output at request time. */
  status: string;
}

/** Stored as the `review` event after a reviewer session. */
export interface ReviewRecord {
  round: number;
  agentId: string;
  /** `null` when the reply had no verdict line; the task then goes to a human. */
  verdict: Verdict | null;
  /** The reviewer's reply without the verdict line. */
  findings: string;
  head: string;
}

/** Stored as the `test_request` event when a finished step is sent to the tester. */
export interface TestRequest {
  round: number;
  /** Commit the step is measured from: the last approved head, or the task's base. */
  since: string;
  /**
   * A `base` task's earlier stretches of its own work still to check, oldest first; the
   * commits between them are other work in the folder. Missing in requests stored before.
   */
  earlier?: CommitSpan[];
  head: string;
  /** `git status --porcelain` output at request time. */
  status: string;
}

/** Stored as the `spec_written` event once the agreed spec is committed to the repository. */
export interface SpecRecord {
  /** Repository-relative path of the spec file. */
  path: string;
  /** HEAD after the spec was committed. */
  head: string;
}

/** Stored as the `test_report` event after a tester session. */
export interface TestReport {
  round: number;
  agentId: string;
  /** `null` when the reply had no verdict line; the task then goes to a human. */
  verdict: 'pass' | 'fail' | null;
  /** The tester's reply without the verdict line. */
  findings: string;
  head: string;
}

/**
 * Stored as the `role_note` event after each finished workflow session: what that role
 * reports to the roles after it. The harness writes these to the task's notes file; the
 * agents only read it.
 */
export interface RoleNote {
  role: AgentRole;
  agentId: string;
  /** A tester's or reviewer's verdict, as recorded in its report or review. */
  verdict: 'pass' | 'fail' | 'approve' | 'changes' | null;
  /** The reply's notes section, or the whole reply when it has none. */
  text: string;
}

/**
 * What a task's current session is doing, while it runs. `chatting`: the user is talking
 * to the agent in the task's conversation, outside the workflow.
 */
export type TaskPhase =
  'planning' | 'writingSpec' | 'implementing' | 'testing' | 'verifying' | 'reviewing' | 'chatting';

export interface TaskActivity {
  phase: TaskPhase;
  /** Agent profile running the phase; `null` while the harness itself verifies. */
  agentId: string | null;
}

/**
 * Stored as the `chat_message` event when the user writes to a task's agent. The task
 * returns to `returnTo` once the agent's reply ends, or after a restart cut it off.
 */
export interface ChatMessage {
  text: string;
  returnTo: TaskStatus;
}

/** Stored as the `chat_end` event when the agent's reply to a chat message ends. */
export interface ChatEnd {
  reason: SessionEndReason;
}

/**
 * Stored as the `chat_queued` event when the user writes to a task that is busy. Pending
 * messages are sent together, as one `chat_message`, once the task's current step ends.
 */
export interface ChatQueued {
  text: string;
}

/**
 * Stored as the `chat_queue_cleared` event when pending messages are dropped unsent:
 * the user cancelled them, or the task stopped with no conversation they could go into.
 */
export interface ChatQueueCleared {
  reason: 'cancelled' | 'undeliverable';
  /** Why they could not be sent, for `undeliverable`. */
  detail?: string;
}

/** One line of a task's chat (`GET /api/tasks/:id/chat`), oldest first. */
export type ChatEntry =
  | { kind: 'user'; ts: number; text: string }
  | { kind: 'pending'; ts: number; text: string }
  | { kind: 'dropped'; ts: number; text: string; cleared: ChatQueueCleared }
  | { kind: 'agent'; ts: number; text: string }
  | { kind: 'tool'; ts: number; name: string; summary: string }
  | { kind: 'compact'; ts: number; preTokens: number; postTokens: number }
  | { kind: 'end'; ts: number; reason: SessionEndReason };

/** One step of a task's history (`GET /api/tasks/:id/timeline`), oldest first. */
export type TimelineEntry =
  | {
      kind: 'session';
      ts: number;
      session: Session;
      /** The agent's final reply, shortened; `null` while running or when it gave none. */
      summary: string | null;
    }
  | { kind: 'features'; ts: number; snapshot: FeatureSnapshot }
  | { kind: 'review_request'; ts: number; request: ReviewRequest }
  | { kind: 'review'; ts: number; review: ReviewRecord }
  | { kind: 'handoff'; ts: number; note: string | null }
  | { kind: 'plan'; ts: number; proposal: PlanProposal }
  | { kind: 'plan_feedback'; ts: number; message: string }
  | { kind: 'plan_approved'; ts: number; approval: PlanApproval }
  | { kind: 'criteria'; ts: number; proposal: CriteriaProposal }
  | { kind: 'criteria_approved'; ts: number; approval: CriteriaApproval }
  | { kind: 'test_report'; ts: number; report: TestReport }
  | { kind: 'spec_written'; ts: number; spec: SpecRecord }
  | { kind: 'chat_message'; ts: number; message: ChatMessage }
  | { kind: 'merge_conflict'; ts: number; conflict: MergeConflict }
  | { kind: 'merged'; ts: number; merge: MergeRecord }
  | { kind: 'permission_request'; ts: number; request: PermissionRequest }
  | { kind: 'permission_decision'; ts: number; decision: PermissionDecisionRecord };
