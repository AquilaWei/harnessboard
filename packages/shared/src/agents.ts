// SPDX-License-Identifier: Apache-2.0

/** Agent CLIs Harnessboard can drive. Each needs an adapter in `@harnessboard/core`. */
export const AGENT_PROVIDERS = ['claude-code'] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

/** A named way to run an agent, e.g. `claude` or a second profile using another model. */
export interface AgentProfile {
  provider: AgentProvider;
  /** Command or absolute path; resolved through PATH. */
  command: string;
  /** Passed to the CLI's model option; `null` keeps the CLI default. */
  model: string | null;
  /** Used when the CLI does not report its context window. */
  contextWindow?: number;
}

/** What a session was asked to do. */
export type AgentRole = 'implementer' | 'reviewer';

/** Which agent profile plays each role in a task. */
export interface TaskAgents {
  implementer: string;
  /** Checks every finished step; `null` skips review. */
  reviewer: string | null;
  /** Review rounds per step before the task goes to a human anyway. */
  maxReviewRounds: number;
}

/** An agent profile and whether its CLI runs on this machine (`GET /api/agents`). */
export interface AgentInfo {
  id: string;
  profile: AgentProfile;
  ok: boolean;
  /** CLI version line, when it ran. */
  version: string | null;
  error: string | null;
}
