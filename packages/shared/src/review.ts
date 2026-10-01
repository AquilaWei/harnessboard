// SPDX-License-Identifier: Apache-2.0
import type {
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

/**
 * What a task's current session is doing, while it runs. `chatting`: the user is talking
 * to the agent in the task's conversation, outside the workflow.
 */
export type TaskPhase = 'planning' | 'implementing' | 'verifying' | 'reviewing' | 'chatting';

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
  | { kind: 'chat_message'; ts: number; message: ChatMessage }
  | { kind: 'merge_conflict'; ts: number; conflict: MergeConflict }
  | { kind: 'merged'; ts: number; merge: MergeRecord }
  | { kind: 'permission_request'; ts: number; request: PermissionRequest }
  | { kind: 'permission_decision'; ts: number; decision: PermissionDecisionRecord };
