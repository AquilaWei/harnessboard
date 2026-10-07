// SPDX-License-Identifier: Apache-2.0
import type { AgentEvent, AgentProvider, ModelInfo, QuotaInfo } from '@harnessboard/shared';

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
  /**
   * First message. Adapters without `midTurnInput` pass it as an argument unless they
   * implement {@link AgentAdapter.encodePrompt}.
   */
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
  /**
   * Ask the harness about tools outside `allowedTools` instead of refusing them; only for
   * `edit` sessions of a CLI with `permissionPrompts`, and ignored with `skipPermissions`.
   */
  askPermission: boolean;
  /**
   * Directories outside `cwd` the session must be able to read, such as the review
   * evidence of a reviewer without `readOnlyGit`. Absent or empty for none.
   */
  readableDirs?: string[];
}

/** Turns CLI output lines into events; see {@link AgentAdapter.createParser}. */
export type LineParser = (line: string) => AgentEvent[];

/** The answer to a `permission_request` event. */
export interface PermissionReply {
  behavior: 'allow' | 'deny';
  /** Deny only: why, so the agent can try something else. */
  message?: string;
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
  /**
   * The CLI can pause on a tool its rules do not allow, emit `permission_request` and wait
   * for {@link AgentAdapter.encodePermissionReply}. Without it such tools are refused.
   */
  permissionPrompts: boolean;
  /**
   * A `readOnly` session can still run `git log`, `git diff` and `git status`. Without it a
   * reviewer could not see the work it judges, so the harness runs those commands itself and
   * puts their output in the reviewer's prompt.
   */
  readOnlyGit: boolean;
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
  /**
   * Encodes the whole prompt for stdin, which the runner closes right after it. Only for
   * CLIs without `midTurnInput`. A CLI that reads its prompt there takes one of any
   * length, while a prompt argument fails on Windows: a `.cmd` shim runs through cmd.exe,
   * whose command line holds at most 8,191 characters. Absent: the prompt is an argument.
   */
  encodePrompt?(text: string): string;
  /** Encodes the answer to a permission request; only called with `permissionPrompts`. */
  encodePermissionReply(
    request: Extract<AgentEvent, { kind: 'permission_request' }>,
    reply: PermissionReply,
  ): string;
  /** Normalises one stdout line; unknown or irrelevant lines yield no events. */
  parseLine(line: string): AgentEvent[];
  /**
   * A parser that remembers earlier lines of one CLI process, for CLIs whose final result
   * has to be assembled from several lines. The runner uses it when present, one per
   * process; adapters are shared by all sessions of a profile, so they can not keep that
   * state themselves.
   */
  createParser?(): LineParser;
  /**
   * The models this CLI offers, as its platform lists them. Absent when the CLI can not
   * list them; then any model id can still be typed. Rejects when listing fails.
   */
  listModels?(): Promise<ModelInfo[]>;
  /**
   * The account's latest usage, read from the CLI's own records, for CLIs whose output does
   * not report it as `quota` events. `null` when nothing is recorded yet.
   */
  readQuota?(): Promise<QuotaInfo | null>;
  /** Arguments that print the CLI version; used to check the CLI is installed. */
  readonly versionArgs: string[];
  /**
   * Arguments that reopen a session in the CLI's own interactive UI (`hb open`), run in
   * `cwd`, the task's folder.
   */
  interactiveResumeArgs(agentSessionId: string, cwd: string): string[];
  /**
   * Files and folders outside the task's folder that a session with `access` needs: the
   * CLI's login and settings, and any file `buildArgs` writes for it. A Docker sandbox
   * mounts the ones that exist. Absent: none.
   */
  configPaths?(access: SessionAccess): string[];
  /**
   * Checked before a session is started, so a task fails with this error instead of
   * running somewhere it should not; the Docker sandbox rejects when docker can not run.
   * Absent: the spawn itself is the check.
   */
  ensureReady?(): Promise<void>;
}
