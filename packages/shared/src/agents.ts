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

/** The command each provider's CLI installs as; detection looks for these on PATH. */
export const DEFAULT_COMMANDS: Record<AgentProvider, string> = {
  'claude-code': 'claude',
  codex: 'codex',
};

/** Profile ids: a letter or digit, then letters, digits, `-` and `_`. */
const PROFILE_ID = /^[A-Za-z0-9][\w-]*$/;

/** True for a string that can name an agent profile. */
export function isProfileId(id: string): boolean {
  return PROFILE_ID.test(id);
}

/** What a session was asked to do. */
export type AgentRole = 'spec' | 'implementer' | 'tester' | 'reviewer';

/**
 * A model a profile's CLI offers (`GET /api/agents/:id/models`), as the platform describes
 * it. Any other id the CLI accepts can still be typed by hand.
 */
export interface ModelInfo {
  /** What is passed to the CLI's model option. */
  id: string;
  name: string;
  description: string | null;
  /** A caveat the platform shows with the model, e.g. that it needs usage credits. */
  note: string | null;
  /** Listed among further models rather than the main choices. */
  more: boolean;
}

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
  /**
   * Agent that writes the spec (the acceptance criteria discussed with the user before
   * anything is built); absent or `null` lets the implementer do it.
   */
  spec?: string | null;
  /** Model for the spec author; absent or `null` uses the profile's model. */
  specModel?: string | null;
  /**
   * Agent that tests each finished implementer step before it is reviewed: it writes the
   * missing tests and runs them. Absent or `null` skips testing.
   */
  tester?: string | null;
  /** Model for the tester; absent or `null` uses the profile's model. */
  testerModel?: string | null;
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

/** An agent CLI found on this machine (`GET /api/agents/detect`). */
export interface DetectedAgent {
  provider: AgentProvider;
  command: string;
  /** CLI version line. */
  version: string;
  /** Profile that already runs this CLI, or `null` when one can still be added. */
  profileId: string | null;
}

/** A profile to add to the user config (`POST /api/agents`). */
export interface NewAgentProfile {
  id: string;
  provider: AgentProvider;
  command: string;
  model: string | null;
}

/** The agent profile that plays `role` in a task; `null` when the role is off (no reviewer or tester). */
export function roleAgent(agents: TaskAgents, role: AgentRole): string | null {
  if (role === 'reviewer') return agents.reviewer;
  if (role === 'tester') return agents.tester ?? null;
  if (role === 'spec') return agents.spec ?? agents.implementer;
  return agents.implementer;
}

/** The model chosen for `role` in a task; `null` means the agent profile's own model. */
export function roleModel(agents: TaskAgents, role: AgentRole): string | null {
  if (role === 'reviewer') return agents.reviewerModel ?? null;
  if (role === 'implementer') return agents.implementerModel ?? null;
  if (role === 'tester') return agents.testerModel ?? null;
  // A spec author left unset is the implementer, so it keeps the implementer's model too.
  if (agents.specModel) return agents.specModel;
  return agents.spec ? null : (agents.implementerModel ?? null);
}
