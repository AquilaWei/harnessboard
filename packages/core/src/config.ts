// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';
import { APP_NAME, ENV_PREFIX, PROJECT_CONFIG_FILE, resolveThresholds } from '@harnessboard/shared';
import type { ContextPolicy } from '@harnessboard/shared';

export interface HarnessConfig {
  /** Holds the database and task worktrees. */
  dataDir: string;
  /** Agent CLI command or absolute path; resolved through PATH. */
  claudePath: string;
  /** Model passed to `--model`; `null` keeps the CLI default. */
  model: string | null;
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
}

/** Settings the web UI may change at runtime; they are saved to the user config file. */
export type EditableSettings = Pick<
  HarnessConfig,
  'maxConcurrent' | 'quotaPauseUtilization' | 'defaultContextPolicy'
>;
export const EDITABLE_SETTINGS = [
  'maxConcurrent',
  'quotaPauseUtilization',
  'defaultContextPolicy',
] as const;

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
    claudePath: 'claude',
    model: null,
    port: 4317,
    maxConcurrent: 1,
    quotaPauseUtilization: 0.95,
    fallbackContextWindow: 200_000,
    quotaRetryMinutes: 15,
    maxHandoffs: 20,
    verifyTimeoutMinutes: 10,
    loopStallSessions: 3,
    defaultContextPolicy: { size: 'medium' },
  };
}

/** Location of the per-user config file for this platform. */
export function userConfigFile(): string {
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
  const fromFile = readJsonIfExists(options.configFile ?? userConfigFile()) as
    Partial<HarnessConfig> | undefined;
  const merged: HarnessConfig = {
    ...defaultConfig(env),
    ...fromFile,
    ...fromEnv(env),
    ...options.overrides,
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

function fromEnv(env: Env): Partial<HarnessConfig> {
  const out: Partial<HarnessConfig> = {};
  const get = (name: string) => env[`${ENV_PREFIX}${name}`];
  const claudePath = get('CLAUDE_PATH');
  if (claudePath) out.claudePath = claudePath;
  const model = get('MODEL');
  if (model) out.model = model;
  const port = get('PORT');
  if (port) out.port = Number(port);
  const maxConcurrent = get('MAX_CONCURRENT');
  if (maxConcurrent) out.maxConcurrent = Number(maxConcurrent);
  return out;
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
