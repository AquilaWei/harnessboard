// SPDX-License-Identifier: Apache-2.0
import type { CriteriaApproval, CriteriaProposal, Session } from './task.js';
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

/** What a task's current session is doing, while it runs. */
export type TaskPhase = 'planning' | 'implementing' | 'verifying' | 'reviewing';

export interface TaskActivity {
  phase: TaskPhase;
  /** Agent profile running the phase; `null` while the harness itself verifies. */
  agentId: string | null;
}

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
  | { kind: 'permission_request'; ts: number; request: PermissionRequest }
  | { kind: 'permission_decision'; ts: number; decision: PermissionDecisionRecord };
