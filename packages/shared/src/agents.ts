// SPDX-License-Identifier: Apache-2.0

/** Agent CLIs Harnessboard can drive. Each needs an adapter in `@harnessboard/core`. */
export const AGENT_PROVIDERS = ['claude-code', 'codex', 'gemini'] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

/** A named way to run an agent, e.g. `claude` or a second profile using another model. */
export interface AgentProfile {
  provider: AgentProvider;
  /** Command or absolute path; resolved through PATH. */
  command: string;
  /** Passed to the CLI's model option; `null` keeps the CLI default. */
  model: string | null;
  /**
   * Reasoning effort passed to the CLI when a task leaves the role's effort unset and the
   * session runs this profile's own model. Absent: the CLI's default.
   */
  effort?: string;
  /** Used when the CLI does not report its context window. */
  contextWindow?: number;
  /**
   * `docker` runs every session of this profile in a container that only mounts the
   * task's folder, its git directory and the CLI's own config. Absent: on this machine.
   */
  sandbox?: 'docker';
  /** The image for `sandbox: 'docker'`; it must have `command` on its PATH. */
  sandboxImage?: string;
}

/** The command each provider's CLI installs as; detection looks for these on PATH. */
export const DEFAULT_COMMANDS: Record<AgentProvider, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
};

/** Profile ids: a letter or digit, then letters, digits, `-` and `_`. */
const PROFILE_ID = /^[A-Za-z0-9][\w-]*$/;

/** True for a string that can name an agent profile. */
export function isProfileId(id: string): boolean {
  return PROFILE_ID.test(id);
}

/** What a session was asked to do. */
export type AgentRole = 'spec' | 'designer' | 'implementer' | 'tester' | 'reviewer';

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
  /** Reasoning efforts the model offers, in the platform's order; empty when it offers no choice. */
  efforts: EffortInfo[];
  /** The effort the CLI uses when none is passed; `null` when the platform does not say. */
  defaultEffort: string | null;
}

/** A reasoning effort a model offers, e.g. `high`, as the platform describes it. */
export interface EffortInfo {
  /** What is passed to the CLI's effort option. */
  id: string;
  name: string;
  description: string | null;
  /** A caveat the platform shows with the effort, e.g. that it uses more of the limits. */
  note: string | null;
}

// Letters, digits and the punctuation model ids use, e.g. `claude-opus-5-5` or `opus[1m]`;
// never starting with `-`, so a model can not be read as a CLI option.
const MODEL_ID = /^[A-Za-z0-9][\w.:/@[\]-]*$/;

/** True for a string that can be passed to an agent CLI as a model id. */
export function isModelId(model: string): boolean {
  return MODEL_ID.test(model);
}

// Effort ids are single words such as `high` or `xhigh`; never starting with `-`, so an
// effort can not be read as a CLI option.
const EFFORT_ID = /^[A-Za-z0-9][\w-]*$/;

/** True for a string that can be passed to an agent CLI as a reasoning effort. */
export function isEffortId(effort: string): boolean {
  return EFFORT_ID.test(effort);
}

/** Which agent profile plays each role in a task. */
export interface TaskAgents {
  implementer: string;
  /** Checks every finished step; `null` skips review. */
  reviewer: string | null;
  /** Model for the implementer; absent or `null` uses the profile's model. */
  implementerModel?: string | null;
  /** Reasoning effort for the implementer; absent or `null` uses the CLI's default. */
  implementerEffort?: string | null;
  /** Model for the reviewer; absent or `null` uses the profile's model. */
  reviewerModel?: string | null;
  /** Reasoning effort for the reviewer; absent or `null` uses the CLI's default. */
  reviewerEffort?: string | null;
  /**
   * Agent that writes the spec (the acceptance criteria discussed with the user before
   * anything is built); absent or `null` lets the implementer do it.
   */
  spec?: string | null;
  /** Model for the spec author; absent or `null` uses the profile's model. */
  specModel?: string | null;
  /** Reasoning effort for the spec author; absent or `null` uses the CLI's default. */
  specEffort?: string | null;
  /**
   * Agent that tests each finished implementer step before it is reviewed: it writes the
   * missing tests and runs them. Absent or `null` skips testing.
   */
  tester?: string | null;
  /** Model for the tester; absent or `null` uses the profile's model. */
  testerModel?: string | null;
  /** Reasoning effort for the tester; absent or `null` uses the CLI's default. */
  testerEffort?: string | null;
  /**
   * Agent that adds a "UI design" section to the spec file once the spec is written, before
   * the implementer starts. Absent or `null` skips it, as for a task without a UI.
   */
  designer?: string | null;
  /** Model for the designer; absent or `null` uses the profile's model. */
  designerModel?: string | null;
  /** Reasoning effort for the designer; absent or `null` uses the CLI's default. */
  designerEffort?: string | null;
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
  /** The profile's default reasoning effort; absent or `null` keeps the CLI default. */
  effort?: string | null;
}

/** A change to a profile's default reasoning effort (`PUT /api/agents/:id/effort`). */
export interface AgentEffortUpdate {
  /** `null` removes it, so the CLI's default applies again. */
  effort: string | null;
}

/**
 * The agent profile that plays `role` in a task; `null` when the role is off (no reviewer,
 * tester or designer).
 */
export function roleAgent(agents: TaskAgents, role: AgentRole): string | null {
  if (role === 'reviewer') return agents.reviewer;
  if (role === 'tester') return agents.tester ?? null;
  if (role === 'designer') return agents.designer ?? null;
  if (role === 'spec') return agents.spec ?? agents.implementer;
  return agents.implementer;
}

/** The model chosen for `role` in a task; `null` means the agent profile's own model. */
export function roleModel(agents: TaskAgents, role: AgentRole): string | null {
  if (role === 'reviewer') return agents.reviewerModel ?? null;
  if (role === 'implementer') return agents.implementerModel ?? null;
  if (role === 'tester') return agents.testerModel ?? null;
  if (role === 'designer') return agents.designerModel ?? null;
  // A spec author left unset is the implementer, so it keeps the implementer's model too.
  if (agents.specModel) return agents.specModel;
  return agents.spec ? null : (agents.implementerModel ?? null);
}

/** The reasoning effort chosen for `role` in a task; `null` means the CLI's default. */
export function roleEffort(agents: TaskAgents, role: AgentRole): string | null {
  if (role === 'reviewer') return agents.reviewerEffort ?? null;
  if (role === 'implementer') return agents.implementerEffort ?? null;
  if (role === 'tester') return agents.testerEffort ?? null;
  if (role === 'designer') return agents.designerEffort ?? null;
  // A spec author left unset is the implementer, so it keeps the implementer's effort too.
  if (agents.specEffort) return agents.specEffort;
  return agents.spec ? null : (agents.implementerEffort ?? null);
}
