// SPDX-License-Identifier: Apache-2.0
import type { AgentEvent, AgentProvider } from '@harnessboard/shared';

/** Tools a session may use: `edit` implements, `readOnly` only inspects (reviewers). */
export type SessionAccess = 'edit' | 'readOnly';

export interface SessionSpec {
  cwd: string;
  /**
   * Session to create (when the adapter lets the harness choose ids) or to resume.
   * `null` for a new session of a CLI that assigns its own ids.
   */
  sessionId: string | null;
  /** Continue `sessionId` instead of starting a new session. */
  resume: boolean;
  /** First message; adapters without stdin input pass it as an argument. */
  prompt: string;
  model: string | null;
  access: SessionAccess;
  /**
   * Extra tool rules: the task's list for `edit` sessions; for `readOnly` sessions only
   * checks that do not change files, such as the task's verify command.
   */
  allowedTools: string[];
  /** Turns off the CLI's permission checks; only honoured for `edit` sessions. */
  skipPermissions: boolean;
}

/**
 * Differences between agent CLIs that change how the harness drives them.
 * See docs/architecture.md for what each known CLI supports.
 */
export interface AgentCapabilities {
  /**
   * The CLI reads further user messages on stdin while it works. Without it the prompt is
   * passed as an argument, and a wrap-up request waits until the turn ends and is sent by
   * resuming the session.
   */
  midTurnInput: boolean;
  /** `harness`: the harness picks the session id up front; `agent`: the CLI reports it in `init`. */
  sessionIds: 'harness' | 'agent';
}

/**
 * What the harness needs from an agent CLI. The runner never builds CLI arguments or
 * parses output itself, so adding a CLI means adding one adapter and registering it in
 * `providers.ts`.
 */
export interface AgentAdapter {
  readonly provider: AgentProvider;
  readonly command: string;
  readonly capabilities: AgentCapabilities;
  buildArgs(spec: SessionSpec): string[];
  /** Encodes one user message for stdin; only called when `midTurnInput` is true. */
  encodeMessage(text: string): string;
  /** Normalises one stdout line; unknown or irrelevant lines yield no events. */
  parseLine(line: string): AgentEvent[];
  /** Arguments that print the CLI version; used to check the CLI is installed. */
  readonly versionArgs: string[];
  /** Arguments that reopen a session in the CLI's own interactive UI (`hb open`). */
  interactiveResumeArgs(agentSessionId: string): string[];
}
