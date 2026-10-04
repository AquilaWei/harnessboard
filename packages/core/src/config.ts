// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';
import {
  AGENT_PROVIDERS,
  APP_NAME,
  ENV_PREFIX,
  PROJECT_CONFIG_FILE,
  assertToolRules,
  resolveThresholds,
} from '@harnessboard/shared';
import type { AgentProfile, ContextPolicy } from '@harnessboard/shared';

export interface HarnessConfig {
  /** Holds the database and task worktrees. */
  dataDir: string;
  /** Agent profiles by id. `claude` always exists and implements tasks by default. */
  agents: Record<string, AgentProfile>;
  /** Profile id that reviews new tasks' work; `null` for no review. */
  defaultReviewer: string | null;
  port: number;
  maxConcurrent: number;
  /** 0–1; no new session starts while five-hour usage is at or above this. */
  quotaPauseUtilization: number;
  /** Used until the agent reports the real window for a model. */
  fallbackContextWindow: number;
  /** Retry interval when a quota error carries no reset time. */
  quotaRetryMinutes: number;
  /** Upper bound on automatic session handoffs per task, to stop runaway loops. */
  maxHandoffs: number;
  /** A verify run that takes longer is killed and counts as failed. */
  verifyTimeoutMinutes: number;
  /** A loop task stops for review after this many sessions without verified progress. */
  loopStallSessions: number;
  /** Applied to new tasks before project and per-task settings. */
  defaultContextPolicy: ContextPolicy;
  /** Tool rules every task's sessions may use without asking, on top of the task's own. */
  allowedTools: string[];
  /**
   * Text files (for example a coding-standards skill) whose rules every reviewer checks the
   * work against. Read at each review, so edits apply to the next one; `~` is the home folder.
   */
  reviewGuidelines: string[];
}

/** Settings the web UI may change at runtime; they are saved to the user config file. */
export type EditableSettings = Pick<
  HarnessConfig,
  | 'maxConcurrent'
  | 'quotaPauseUtilization'
  | 'defaultContextPolicy'
  | 'defaultReviewer'
  | 'allowedTools'
  | 'reviewGuidelines'
>;
export const EDITABLE_SETTINGS = [
  'maxConcurrent',
  'quotaPauseUtilization',
  'defaultContextPolicy',
  'defaultReviewer',
  'allowedTools',
  'reviewGuidelines',
] as const;

/** Profile every config has; tasks use it unless they name another implementer. */
export const DEFAULT_AGENT = 'claude';

/** Defaults a repository can set in its `.harnessboard.json`. */
export interface ProjectConfig {
  baseRef?: string;
  allowedTools?: string[];
  contextPolicy?: ContextPolicy;
  /** Default verify command for loop tasks in this repository. */
  verifyCommand?: string;
}

type Env = Record<string, string | undefined>;

export function defaultConfig(env: Env = process.env): HarnessConfig {
  const paths = envPaths(APP_NAME, { suffix: '' });
  return {
    dataDir: env[`${ENV_PREFIX}HOME`] ?? paths.data,
    agents: { [DEFAULT_AGENT]: { provider: 'claude-code', command: 'claude', model: null } },
    defaultReviewer: null,
    port: 4317,
    maxConcurrent: 1,
    quotaPauseUtilization: 0.95,
    fallbackContextWindow: 200_000,
    quotaRetryMinutes: 15,
    maxHandoffs: 20,
    verifyTimeoutMinutes: 10,
    loopStallSessions: 3,
    defaultContextPolicy: { size: 'medium' },
    allowedTools: [],
    reviewGuidelines: [],
  };
}

/**
 * Location of the per-user config file: inside `HARNESSBOARD_HOME` when it is set, so a
 * separate home (for example a test instance) never reads or changes the user's settings;
 * otherwise in this platform's config folder.
 */
export function userConfigFile(env: Env = process.env): string {
  const home = env[`${ENV_PREFIX}HOME`];
  if (home) return path.join(home, 'config.json');
  return path.join(envPaths(APP_NAME, { suffix: '' }).config, 'config.json');
}

/**
 * Builds the effective config: defaults < user config file < environment < overrides.
 * Throws when a config file exists but is not valid JSON, or a numeric value is invalid;
 * a missing user config file is fine.
 */
export function loadConfig(
  options: { env?: Env; overrides?: Partial<HarnessConfig>; configFile?: string } = {},
): HarnessConfig {
  const env = options.env ?? process.env;
  const fromFile = readJsonIfExists(options.configFile ?? userConfigFile(env)) as
    Partial<HarnessConfig> | undefined;
  const defaults = defaultConfig(env);
  // Profiles merge by id so a file that only adds a reviewer keeps the default `claude`.
  const fromUser: HarnessConfig = {
    ...defaults,
    ...fromFile,
    agents: { ...defaults.agents, ...fromFile?.agents },
  };
  applyEnv(fromUser, env);
  const merged: HarnessConfig = {
    ...fromUser,
    ...options.overrides,
    agents: { ...fromUser.agents, ...options.overrides?.agents },
  };
  validate(merged);
  return merged;
}

/** Reads `.harnessboard.json` from a repository root; empty when absent. */
export function loadProjectConfig(repoPath: string): ProjectConfig {
  return (readJsonIfExists(path.join(repoPath, PROJECT_CONFIG_FILE)) as ProjectConfig) ?? {};
}

/**
 * Merges `patch` into the user config file, keeping keys it does not mention.
 * Environment variables still take precedence on the next start.
 */
export function saveUserConfig(patch: Partial<HarnessConfig>, file = userConfigFile()): void {
  const current = (readJsonIfExists(file) as Partial<HarnessConfig> | undefined) ?? {};
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2) + '\n');
}

/**
 * Adds or replaces one agent profile in the user config file, keeping the other profiles
 * and keys it holds. Only the file's own profiles are written, so defaults and environment
 * overrides never end up saved there.
 */
export function saveUserAgent(id: string, profile: AgentProfile, file = userConfigFile()): void {
  const current = (readJsonIfExists(file) as Partial<HarnessConfig> | undefined) ?? {};
  saveUserConfig({ agents: { ...current.agents, [id]: profile } }, file);
}

/** Environment variables override the file; `CLAUDE_PATH` and `MODEL` apply to `claude`. */
function applyEnv(config: HarnessConfig, env: Env): void {
  const get = (name: string) => env[`${ENV_PREFIX}${name}`];
  const claude = config.agents[DEFAULT_AGENT];
  const command = get('CLAUDE_PATH');
  const model = get('MODEL');
  if (claude && (command || model)) {
    config.agents[DEFAULT_AGENT] = {
      ...claude,
      ...(command ? { command } : {}),
      ...(model ? { model } : {}),
    };
  }
  const port = get('PORT');
  if (port) config.port = Number(port);
  const maxConcurrent = get('MAX_CONCURRENT');
  if (maxConcurrent) config.maxConcurrent = Number(maxConcurrent);
}

/** Throws when a value is out of range; used for loaded config and runtime edits alike. */
export function validate(config: HarnessConfig): void {
  const positiveInts: (keyof HarnessConfig)[] = [
    'port',
    'maxConcurrent',
    'fallbackContextWindow',
    'quotaRetryMinutes',
    'maxHandoffs',
    'verifyTimeoutMinutes',
    'loopStallSessions',
  ];
  for (const key of positiveInts) {
    const value = config[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`config ${key} must be a positive integer, got ${String(value)}`);
    }
  }
  if (!(config.quotaPauseUtilization > 0 && config.quotaPauseUtilization <= 1)) {
    throw new Error('config quotaPauseUtilization must be in (0, 1]');
  }
  resolveThresholds(config.defaultContextPolicy);
  if (!Array.isArray(config.allowedTools)) throw new Error('config allowedTools must be a list');
  assertToolRules(config.allowedTools);
  if (
    !Array.isArray(config.reviewGuidelines) ||
    !config.reviewGuidelines.every((f) => typeof f === 'string' && f.trim() !== '')
  ) {
    throw new Error('config reviewGuidelines must be a list of file paths');
  }
  if (!config.agents[DEFAULT_AGENT]) {
    throw new Error(`config agents must include "${DEFAULT_AGENT}"`);
  }
  for (const [id, profile] of Object.entries(config.agents)) {
    if (!(AGENT_PROVIDERS as readonly string[]).includes(profile.provider)) {
      throw new Error(
        `config agents.${id}.provider must be one of ${AGENT_PROVIDERS.join(', ')}, got ${String(profile.provider)}`,
      );
    }
    if (typeof profile.command !== 'string' || profile.command === '') {
      throw new Error(`config agents.${id}.command must be a non-empty string`);
    }
  }
  if (config.defaultReviewer !== null && !config.agents[config.defaultReviewer]) {
    throw new Error(`config defaultReviewer "${config.defaultReviewer}" is not an agent profile`);
  }
}

function readJsonIfExists(file: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${(err as Error).message}`);
  }
}
