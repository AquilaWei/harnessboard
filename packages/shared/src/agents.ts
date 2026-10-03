// SPDX-License-Identifier: Apache-2.0

/** Agent CLIs Harnessboard can drive. Each needs an adapter in `@harnessboard/core`. */
export const AGENT_PROVIDERS = ['claude-code', 'codex'] as const;
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

/**
 * Models offered for each provider. Any other id the CLI accepts can be typed instead;
 * Claude Code resolves these aliases to the latest model of that family.
 */
export const MODEL_SUGGESTIONS: Record<AgentProvider, readonly string[]> = {
  'claude-code': ['opus', 'sonnet', 'haiku'],
  codex: [],
};

// Letters, digits and the punctuation model ids use, e.g. `claude-opus-5-5` or `opus[1m]`;
// never starting with `-`, so a model can not be read as a CLI option.
const MODEL_ID = /^[A-Za-z0-9][\w.:/@[\]-]*$/;

/** True for a string that can be passed to an agent CLI as a model id. */
export function isModelId(model: string): boolean {
  return MODEL_ID.test(model);
}

/** Which agent profile plays each role in a task. */
export interface TaskAgents {
  implementer: string;
  /** Checks every finished step; `null` skips review. */
  reviewer: string | null;
  /** Model for the implementer; absent or `null` uses the profile's model. */
  implementerModel?: string | null;
  /** Model for the reviewer; absent or `null` uses the profile's model. */
  reviewerModel?: string | null;
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
