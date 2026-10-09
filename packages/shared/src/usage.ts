// SPDX-License-Identifier: Apache-2.0
import type { AgentRole } from './agents.js';

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Tokens and reported or estimated cost for one conversation. Claude Code's totals
 * are cumulative for the conversation, also across resumes; a later snapshot replaces an
 * earlier one rather than adding to it.
 */
export interface RunUsage {
  /** USD at API list prices; Codex uses standard short-context rates. Subscriptions are not charged per token. */
  costUsd: number | null;
  models: Record<string, TokenCounts & { costUsd: number | null }>;
}

/** Stored as the `usage` event when one agent run (one CLI process) ends. */
export interface UsageRecord {
  role: AgentRole;
  agentId: string;
  /** Wall time of the run. */
  durationMs: number;
  /** `null` when the agent reported none, e.g. it was stopped before its first reply. */
  usage: RunUsage | null;
  /** False when the provider reports only this process's usage, rather than thread totals. */
  cumulative?: boolean;
}

/** A task's usage over all its sessions (`TaskView.usage`). */
export interface TaskUsage {
  /** Agent runs: workflow steps, resumed steps and chat replies. */
  runs: number;
  /** Time agents spent running. */
  agentMs: number;
  /** From the first session's start to the last one's end, or to now while one runs. */
  elapsedMs: number | null;
  /** `null` when nothing was recorded, e.g. for tasks from before usage was kept. */
  tokens: TokenCounts | null;
  costUsd: number | null;
  byModel: Record<string, TokenCounts & { costUsd: number | null }>;
}

/** `45s`, `12m 5s`, `3h 20m`. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Cents below $10, whole dollars above. */
export function formatCost(usd: number): string {
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`;
}
