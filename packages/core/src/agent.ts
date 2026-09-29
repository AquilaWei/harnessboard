// SPDX-License-Identifier: Apache-2.0
import type { AgentEvent } from '@harnessboard/shared';

export interface SessionSpec {
  cwd: string;
  sessionId: string;
  /** Continue an existing session instead of starting `sessionId` fresh. */
  resume: boolean;
  model: string | null;
  allowedTools: string[];
  skipPermissions: boolean;
}

/**
 * What the harness needs from an agent CLI. Only Claude Code is implemented;
 * the seam exists so the runner never builds CLI arguments or parses output itself.
 */
export interface AgentAdapter {
  readonly command: string;
  buildArgs(spec: SessionSpec): string[];
  /** Encodes one user message for the agent's stdin. */
  encodeMessage(text: string): string;
  /** Normalises one stdout line; unknown or irrelevant lines yield no events. */
  parseLine(line: string): AgentEvent[];
  /** Arguments that print the CLI version; used to check the CLI is installed. */
  readonly versionArgs: string[];
}
