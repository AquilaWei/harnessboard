// SPDX-License-Identifier: Apache-2.0
import { InvalidArgumentError, Option } from 'commander';
import type { Command } from 'commander';
import {
  AGENT_PROVIDERS,
  DEFAULT_PRESET,
  PERMISSION_PRESETS,
  definedOnly,
  presetRules,
} from '@harnessboard/shared';
import type {
  AgentProvider,
  AgentsUpdate,
  CreateTaskInput,
  DetectedAgent,
  NewAgentProfile,
  TaskSize,
} from '@harnessboard/shared';

/** What `hb loop` adds to the task it creates; `hb add` only sets `confirmPlan`. */
export interface LoopInput {
  mode?: 'loop';
  verifyCommand?: string;
  confirmPlan?: boolean;
}

/** The parsed options of {@link withTaskOptions}. */
export interface AddOptions {
  repo: string;
  criteria?: string;
  title?: string;
  base?: string;
  onBase?: boolean;
  size?: TaskSize;
  compact?: number;
  soft?: number;
  hard?: number;
  preset?: string[];
  allow?: string[];
  skipPermissions?: boolean;
  autoApprove?: boolean;
  reviewer?: string;
  model?: string;
  effort?: string;
  reviewerModel?: string;
  reviewerEffort?: string;
  spec?: string;
  specModel?: string;
  specEffort?: string;
  tester?: string;
  testerModel?: string;
  testerEffort?: string;
  designer?: string;
  designerModel?: string;
  designerEffort?: string;
  queue: boolean;
}

/** Options shared by `add` and `loop`. */
export function withTaskOptions(command: Command): Command {
  return command
    .option('-C, --repo <dir>', 'repository to work in', process.cwd())
    .option('--title <title>', 'short title (defaults to the first line of the prompt)')
    .option('--criteria <text>', 'acceptance criteria: what must hold for the work to be done')
    .option('--base <ref>', 'git ref to branch from (defaults to the current branch)')
    .option(
      '--on-base',
      'work directly on the base branch in the repository folder: no worktree, no branch, nothing to merge',
    )
    .addOption(
      new Option('--size <size>', 'task size; sets the soft context threshold').choices([
        'small',
        'medium',
        'large',
      ]),
    )
    .option(
      '--compact <pct>',
      'compact the conversation at this context % (0: never)',
      parseInteger,
    )
    .option('--soft <pct>', 'soft context threshold in percent', parseInteger)
    .option('--hard <pct>', 'hard context threshold in percent', parseInteger)
    .option(
      '--preset <ids>',
      `permission presets, comma-separated: ${PERMISSION_PRESETS.map((p) => p.id).join(', ')} or none (default ${DEFAULT_PRESET})`,
      parsePresets,
    )
    .option('--allow <rules...>', 'more tool rules the agent may use without asking')
    .option('--skip-permissions', 'let the agent run anything (only in a sandbox)')
    .option(
      '--no-auto-approve',
      'ask before every tool the rules do not allow, instead of only dangerous ones',
    )
    .option('--model <model>', 'model for the implementer, e.g. opus, sonnet, haiku')
    .option(
      '--effort <level>',
      'reasoning effort for the implementer, e.g. low, medium, high (see hb agents --models)',
    )
    .option(
      '--spec <agent>',
      'agent profile that writes the acceptance criteria (default: implementer)',
    )
    .option('--spec-model <model>', 'model for the spec author')
    .option('--spec-effort <level>', 'reasoning effort for the spec author')
    .option(
      '--designer <agent>',
      'agent profile that adds a UI design to the approved spec before implementation',
    )
    .option('--designer-model <model>', 'model for the designer')
    .option('--designer-effort <level>', 'reasoning effort for the designer')
    .option('--tester <agent>', 'agent profile that writes and runs tests for each finished step')
    .option('--tester-model <model>', 'model for the tester')
    .option('--tester-effort <level>', 'reasoning effort for the tester')
    .option('--reviewer <agent>', 'agent profile that reviews each finished step, or "none"')
    .option('--reviewer-model <model>', 'model for the reviewer')
    .option('--reviewer-effort <level>', 'reasoning effort for the reviewer')
    .option('--no-queue', 'leave the task in the backlog');
}

/** The `POST /api/tasks` body for the parsed options; unset options are left to the server. */
export function taskInput(prompt: string, o: AddOptions, loop: LoopInput = {}): CreateTaskInput {
  return definedOnly({
    prompt,
    ...loop,
    acceptance: o.criteria,
    repo: o.repo,
    title: o.title,
    baseRef: o.base,
    workspace: o.onBase ? ('base' as const) : undefined,
    size: o.size,
    compactPct: o.compact,
    softPct: o.soft,
    hardPct: o.hard,
    allowedTools: allowedTools(o.preset, o.allow),
    skipPermissions: o.skipPermissions,
    autoApprove: o.autoApprove,
    spec: o.spec,
    specModel: o.specModel,
    specEffort: o.specEffort,
    tester: o.tester,
    testerModel: o.testerModel,
    testerEffort: o.testerEffort,
    designer: o.designer,
    designerModel: o.designerModel,
    designerEffort: o.designerEffort,
    reviewer: o.reviewer === 'none' ? null : o.reviewer,
    implementerModel: o.model,
    implementerEffort: o.effort,
    reviewerModel: o.reviewerModel,
    reviewerEffort: o.reviewerEffort,
    queue: o.queue,
  });
}

/** The parsed options of {@link withAgentOptions}. */
export interface ModelsOptions {
  model?: string;
  effort?: string;
  spec?: string;
  specModel?: string;
  specEffort?: string;
  designer?: string;
  designerModel?: string;
  designerEffort?: string;
  tester?: string;
  testerModel?: string;
  testerEffort?: string;
  reviewer?: string;
  reviewerModel?: string;
  reviewerEffort?: string;
}

/** Options of `hb models`, which change a task's agents, models and efforts. */
export function withAgentOptions(command: Command): Command {
  return command
    .option('--model <model>', 'implementer model, or "default" for the profile model')
    .option('--effort <level>', 'implementer reasoning effort, or "default" for the CLI default')
    .option(
      '--spec <agent>',
      'spec author profile, or "implementer" to let the implementer write it',
    )
    .option('--spec-model <model>', 'spec author model, or "default" for the profile model')
    .option('--spec-effort <level>', 'spec author reasoning effort, or "default"')
    .option('--designer <agent>', 'designer profile, or "none" to skip the UI design')
    .option('--designer-model <model>', 'designer model, or "default" for the profile model')
    .option('--designer-effort <level>', 'designer reasoning effort, or "default"')
    .option('--tester <agent>', 'tester profile, or "none" to skip testing')
    .option('--tester-model <model>', 'tester model, or "default" for the profile model')
    .option('--tester-effort <level>', 'tester reasoning effort, or "default"')
    .option('--reviewer <agent>', 'reviewer profile, or "none"')
    .option('--reviewer-model <model>', 'reviewer model, or "default" for the profile model')
    .option('--reviewer-effort <level>', 'reviewer reasoning effort, or "default"');
}

/**
 * The `PUT /tasks/:id/agents` body for the parsed options: only what was given, with
 * `default`, `none` and `implementer` turned into `null`. Empty when nothing is to change.
 */
export function agentsUpdate(o: ModelsOptions): AgentsUpdate {
  const orDefault = (v?: string) => (v === undefined ? undefined : v === 'default' ? null : v);
  const orNull = (v: string | undefined, none: string) =>
    v === undefined ? undefined : v === none ? null : v;
  return definedOnly({
    implementerModel: orDefault(o.model),
    implementerEffort: orDefault(o.effort),
    spec: orNull(o.spec, 'implementer'),
    specModel: orDefault(o.specModel),
    specEffort: orDefault(o.specEffort),
    designer: orNull(o.designer, 'none'),
    designerModel: orDefault(o.designerModel),
    designerEffort: orDefault(o.designerEffort),
    tester: orNull(o.tester, 'none'),
    testerModel: orDefault(o.testerModel),
    testerEffort: orDefault(o.testerEffort),
    reviewer: orNull(o.reviewer, 'none'),
    reviewerModel: orDefault(o.reviewerModel),
    reviewerEffort: orDefault(o.reviewerEffort),
  });
}

/** The parsed options of {@link withProfileOptions}. */
export interface AgentsOptions {
  models?: string;
  add?: AgentProvider;
  id?: string;
  model?: string;
  effort?: string;
}

/** Options of `hb agents`, which lists profiles and adds one for a CLI found here. */
export function withProfileOptions(command: Command): Command {
  return command
    .addOption(
      new Option('--add <provider>', 'add a profile for a CLI found on this machine').choices(
        AGENT_PROVIDERS,
      ),
    )
    .option('--models <id>', "list the models a profile's CLI offers")
    .option('--id <id>', 'profile id for --add (default: the command name)')
    .option('--model <model>', 'model for --add (default: the CLI default)')
    .option('--effort <level>', 'reasoning effort for --add (default: the CLI default)');
}

/** The `POST /agents` body `hb agents --add` sends for the CLI it found. */
export function profileInput(found: DetectedAgent, o: AgentsOptions): NewAgentProfile {
  return {
    id: o.id ?? found.command,
    provider: found.provider,
    command: found.command,
    model: o.model ?? null,
    effort: o.effort ?? null,
  };
}

/** Preset ids from a comma-separated list; throws on an unknown id. */
export function parsePresets(value: string): string[] {
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id && id !== 'none');
  try {
    presetRules(ids);
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
  return ids;
}

/**
 * Rules to send, or `undefined` to let the server choose. `--allow` alone adds to the
 * default preset, so extra rules never silently take away the git commands.
 */
function allowedTools(presets?: string[], allow?: string[]): string[] | undefined {
  if (!presets && !allow) return undefined;
  return [...new Set([...presetRules(presets ?? [DEFAULT_PRESET]), ...(allow ?? [])])];
}

export function parseInteger(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new InvalidArgumentError('not an integer');
  return n;
}
