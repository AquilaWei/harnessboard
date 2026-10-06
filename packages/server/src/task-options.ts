// SPDX-License-Identifier: Apache-2.0
import { InvalidArgumentError, Option } from 'commander';
import type { Command } from 'commander';
import { DEFAULT_PRESET, PERMISSION_PRESETS, definedOnly, presetRules } from '@harnessboard/shared';
import type { CreateTaskInput, TaskSize } from '@harnessboard/shared';

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
  reviewerModel?: string;
  spec?: string;
  specModel?: string;
  tester?: string;
  testerModel?: string;
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
      '--spec <agent>',
      'agent profile that writes the acceptance criteria (default: implementer)',
    )
    .option('--spec-model <model>', 'model for the spec author')
    .option('--tester <agent>', 'agent profile that writes and runs tests for each finished step')
    .option('--tester-model <model>', 'model for the tester')
    .option('--reviewer <agent>', 'agent profile that reviews each finished step, or "none"')
    .option('--reviewer-model <model>', 'model for the reviewer')
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
    tester: o.tester,
    testerModel: o.testerModel,
    reviewer: o.reviewer === 'none' ? null : o.reviewer,
    implementerModel: o.model,
    reviewerModel: o.reviewerModel,
    queue: o.queue,
  });
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
