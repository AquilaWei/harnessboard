// SPDX-License-Identifier: Apache-2.0

/** Subscription quota snapshot reported by the agent CLI. */
export interface QuotaInfo {
  /** `"allowed"` while requests go through; anything else means limited. */
  status: string;
  /** 0–1 utilisation of the five-hour window, when reported. */
  fiveHourUtilization: number | null;
  /** 0–1 utilisation of the seven-day window, when reported. */
  sevenDayUtilization: number | null;
  /** Unix ms when the five-hour window resets, when reported. */
  fiveHourResetsAt: number | null;
  /** Unix ms when the seven-day window resets, when reported. */
  sevenDayResetsAt: number | null;
  /**
   * Unix ms when the limiting window resets, when reported; it may be either window, so a
   * refused request waits for this one.
   */
  resetsAt: number | null;
}

/**
 * Agent output normalised into the few shapes the harness acts on or shows.
 * Anything else is kept only as raw JSON in the event log.
 */
export type AgentEvent =
  | { kind: 'init'; sessionId: string; model: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; name: string; summary: string }
  | { kind: 'context'; tokens: number }
  | { kind: 'quota'; quota: QuotaInfo }
  | { kind: 'compact'; preTokens: number; postTokens: number }
  | {
      /** The agent wants a tool its rules do not allow and waits for an answer. */
      kind: 'permission_request';
      requestId: string;
      toolName: string;
      /** The command, path or other input in one line, for showing to the user. */
      summary: string;
      /** The tool's full input; the reply echoes it, so it is not stored in the log. */
      input: Record<string, unknown>;
      /** Rules the agent CLI suggests for allowing this, e.g. `Bash(git add *)`. */
      suggestedRules: string[];
    }
  | {
      kind: 'result';
      isError: boolean;
      text: string;
      apiErrorStatus: number | null;
      contextWindow: number | null;
    };

/** Harness-level event pushed to CLI/web subscribers. */
export type HarnessEvent =
  | { type: 'agent'; taskId: number; sessionId: string; event: AgentEvent }
  | { type: 'task'; taskId: number; status: string }
  | { type: 'deleted'; taskId: number }
  | { type: 'harness'; taskId: number; message: string };
