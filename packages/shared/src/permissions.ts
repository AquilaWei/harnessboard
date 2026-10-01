// SPDX-License-Identifier: Apache-2.0

/**
 * A named group of tool rules offered when creating a task, so common needs can be ticked
 * instead of written by hand. `broad` marks a group that grants close to full access.
 */
export interface PermissionPreset {
  id: string;
  rules: string[];
  broad?: boolean;
}

export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  {
    id: 'git',
    rules: [
      'Bash(git status)',
      'Bash(git status *)',
      'Bash(git diff *)',
      'Bash(git log *)',
      'Bash(git add *)',
      'Bash(git commit *)',
      'Bash(git mv *)',
      'Bash(git rm *)',
    ],
  },
  { id: 'node', rules: ['Bash(npm *)', 'Bash(npx *)', 'Bash(pnpm *)', 'Bash(node *)'] },
  {
    id: 'python',
    rules: ['Bash(python *)', 'Bash(python3 *)', 'Bash(pip *)', 'Bash(pytest *)', 'Bash(uv *)'],
  },
  { id: 'gradle', rules: ['Bash(./gradlew *)', 'Bash(gradle *)'] },
  // Containers can mount any folder on the machine, so this is nearly unrestricted.
  { id: 'docker', rules: ['Bash(docker *)'], broad: true },
  { id: 'web', rules: ['WebFetch', 'WebSearch'] },
  { id: 'files', rules: ['Bash(mkdir *)', 'Bash(chmod +x *)'] },
];

/** The preset a task gets when no rules are given: the agent must be able to commit. */
export const DEFAULT_PRESET = 'git';

const TOOL_RULE = /^[A-Za-z][\w-]*(\([^\n]+\))?$/;

/**
 * True for a Claude Code permission rule: a tool name such as `WebSearch` or
 * `mcp__server__tool`, optionally with a specifier in parentheses, e.g. `Bash(npm test)`.
 */
export function isToolRule(rule: string): boolean {
  return TOOL_RULE.test(rule);
}

/**
 * The rules of the given presets, in order and without duplicates.
 * Throws on an unknown preset id, naming the valid ones.
 */
export function presetRules(ids: readonly string[]): string[] {
  const rules: string[] = [];
  for (const id of ids) {
    const preset = PERMISSION_PRESETS.find((p) => p.id === id);
    if (!preset) {
      const known = PERMISSION_PRESETS.map((p) => p.id).join(', ');
      throw new Error(`unknown permission preset "${id}"; choose from ${known}`);
    }
    for (const rule of preset.rules) if (!rules.includes(rule)) rules.push(rule);
  }
  return rules;
}

/**
 * Throws when any rule is not a tool rule, quoting it and showing the expected form.
 * Catches sentences typed into the rules field, which Claude Code would silently ignore.
 */
export function assertToolRules(rules: readonly string[]): void {
  const bad = rules.filter((rule) => !isToolRule(rule));
  if (bad.length > 0) {
    throw new Error(
      `not a tool rule: ${bad.map((r) => JSON.stringify(r)).join(', ')}; ` +
        'write one rule per entry, e.g. Bash(npm test), Bash(git add *) or WebSearch',
    );
  }
}

/** A tool use waiting for the user's answer, as shown on the board. */
export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  summary: string;
  suggestedRules: string[];
  /** Why auto-approve did not allow it on its own; `null` when the task does not auto-approve. */
  risk: string | null;
  /** Unix ms when the agent asked. */
  ts: number;
}

/**
 * The user's answer to a {@link PermissionRequest}. `rules` (allow only) are added to the
 * task, or with `scope: 'global'` to the user's settings for every task, so later sessions
 * may use them without asking; `message` (deny only) tells the agent why.
 */
export interface PermissionDecision {
  requestId: string;
  behavior: 'allow' | 'deny';
  rules?: string[];
  scope?: 'task' | 'global';
  message?: string;
}

/** What was decided, as kept in the task's history. */
export interface PermissionDecisionRecord {
  requestId: string;
  toolName: string;
  summary: string;
  behavior: 'allow' | 'deny';
  /** Rules added with this answer; empty for "allow once" or a denial. */
  rules: string[];
  /** Where `rules` were added; absent in records from before global rules. */
  scope?: 'task' | 'global';
  message: string | null;
  /**
   * True when the harness allowed it without asking: the task's or the global rules covered
   * it, or the task auto-approves and it was not risky.
   */
  auto: boolean;
}
