// SPDX-License-Identifier: Apache-2.0
import type { AgentProfile, AgentProvider } from '@harnessboard/shared';
import type { AgentAdapter } from './agent.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';

/** Builds the adapter for a profile. Tests pass their own to drive fake CLIs. */
export type AdapterFactory = (profile: AgentProfile) => AgentAdapter;

const FACTORIES: Record<AgentProvider, AdapterFactory> = {
  'claude-code': (profile) => new ClaudeCodeAdapter(profile.command),
  codex: (profile) => new CodexAdapter(profile.command),
  gemini: (profile) => new GeminiAdapter(profile.command),
};

/** The adapter for a profile's provider; providers are validated when config loads. */
export const createAdapter: AdapterFactory = (profile) => FACTORIES[profile.provider](profile);
