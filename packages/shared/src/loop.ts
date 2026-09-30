// SPDX-License-Identifier: Apache-2.0

/** Written by the initializer session at the worktree root; maintained by later sessions. */
export const FEATURE_LIST_FILE = 'feature_list.json';
/** Free-form notes each loop session reads first and updates before it ends. */
export const PROGRESS_FILE = 'progress.md';

export interface Feature {
  id: string;
  description: string;
  /** How to check the feature by hand; informational only. */
  steps?: string[];
  /** Set by the agent once it believes the feature works. */
  passes: boolean;
}

/**
 * A planning session's proposal, stored as the `plan` event each time the planner finishes
 * (first plan and every revision). Nothing is built until the user approves.
 */
export interface PlanProposal {
  features: Feature[];
  /** Verify command the planner suggests; it only takes effect once the user confirms it. */
  suggestedVerify: string | null;
  /** Decisions the planner needs from the user. */
  questions: string[];
  /** The planner's reply: a summary of the plan or of what changed. */
  reply: string;
}

/** Stored as the `plan_approved` event; the features become the loop's baseline. */
export interface PlanApproval {
  verifyCommand: string;
  features: Feature[];
}

/** `GET /api/tasks/:id/plan`: the feature list as it is in the worktree right now. */
export interface PlanView {
  /** `null` when the file is missing or invalid; `error` says why. */
  features: Feature[] | null;
  error: string | null;
  suggestedVerify: string | null;
  questions: string[];
  reply: string | null;
  approved: boolean;
}

/** Outcome of the harness running a task's verify command. */
export interface VerifyResult {
  command: string;
  ok: boolean;
  /** `null` when the command was killed (timeout or stop). */
  exitCode: number | null;
  timedOut: boolean;
  /** Tail of combined stdout and stderr. */
  output: string;
}

/**
 * Stored as the `features` event after every loop session. `verifiedPassing` only counts
 * features the agent marked as passing when the harness's own verification succeeded.
 */
export interface FeatureSnapshot {
  features: Feature[];
  verify: VerifyResult | null;
  verifiedPassing: number;
}

/** Feature progress shown on the board. */
export interface LoopProgress {
  total: number;
  /** Marked passing by the agent. */
  claimed: number;
  /** Marked passing and confirmed by the harness's verify run. */
  verified: number;
  /** Result of the latest verify run; `null` before the first coding session ends. */
  lastVerify: VerifyResult | null;
}
