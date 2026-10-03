// SPDX-License-Identifier: Apache-2.0
import os from 'node:os';
import path from 'node:path';

/** Directories no agent has any business changing; a write below one of them is dangerous. */
const SYSTEM_DIRS = [
  '/etc',
  '/boot',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/var',
  '/sys',
  '/proc',
  '/dev',
  // Windows: compared without the drive letter and case, see `comparable`.
  '/windows',
  '/program files',
  '/program files (x86)',
  '/programdata',
];

/** Home-directory entries holding credentials or the user's own tool setup. */
const PROTECTED_HOME = ['.ssh', '.claude'];

/** Commands that stop or reboot the machine. */
const SHUTDOWN_COMMANDS = new Set(['shutdown', 'reboot', 'halt', 'poweroff']);

/** Words that may stand in front of the real command without changing what it does. */
const PREFIX_COMMANDS = new Set(['sudo', 'command', 'exec', 'time', 'nohup']);

/** Whole-command patterns, with the reason shown to the user. */
const DANGEROUS_COMMANDS: [RegExp, string][] = [
  [/--no-preserve-root/, 'deletes the system or your home directory'],
  [/\bmkfs(\.\w+)?\b|\bdd\s+[^|;&]*\bof=\/dev\//, 'writes to a disk'],
  [/>>?\s*\/dev\/(sd|hd|vd|nvme|mmcblk)/, 'writes to a disk'],
  [/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, 'is a fork bomb'],
];

/** Tools that write a file named in their input. */
const FILE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/**
 * Why a tool use is dangerous enough to need the user's answer even though the task
 * auto-approves, or `null` when it may be allowed. Only things that could wreck the system or
 * important data count: wiping the system or home directory, writing to a disk, shutting the
 * machine down, changing system paths, and deleting recursively outside `worktree` (the
 * task's directory). A pattern list cannot catch everything, so this is a safety net, not a sandbox.
 */
export function riskOf(toolName: string, input: unknown, worktree: string): string | null {
  const fields = (input ?? {}) as Record<string, unknown>;
  const fileField = FILE_TOOLS[toolName];
  if (fileField) {
    const file = fields[fileField];
    return typeof file === 'string' && isProtectedPath(file, worktree)
      ? 'writes to a system or credentials path'
      : null;
  }
  if (toolName !== 'Bash') return null;
  const command = typeof fields.command === 'string' ? fields.command : '';
  for (const [pattern, reason] of DANGEROUS_COMMANDS) {
    if (pattern.test(command)) return reason;
  }
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const reason = segmentRisk(segment.trim().split(/\s+/), worktree);
    if (reason) return reason;
  }
  for (const match of command.matchAll(/(?:^|[^<>&\d])>>?\s*([^\s;&|]+)/g)) {
    if (isProtectedPath(match[1]!, worktree)) return 'writes to a system or credentials path';
  }
  return null;
}

/** Risk of one simple command, given as its words. */
function segmentRisk(words: string[], worktree: string): string | null {
  while (words.length > 0 && PREFIX_COMMANDS.has(words[0]!)) words = words.slice(1);
  const [name, ...rest] = words;
  if (!name) return null;
  if (SHUTDOWN_COMMANDS.has(name)) return 'shuts down the machine';
  const flags = rest.filter((word) => word.startsWith('-'));
  const targets = rest.filter((word) => !word.startsWith('-'));
  if (name === 'rm' && flags.some((flag) => /^-\w*[rR]|^--recursive$/.test(flag))) {
    if (targets.some(isWipeTarget)) return 'deletes the system or your home directory';
    if (targets.some((target) => outside(target, worktree))) {
      return "deletes recursively outside the task's worktree";
    }
  }
  if (
    (name === 'chmod' || name === 'chown') &&
    flags.some((flag) => /^-\w*R|^--recursive$/.test(flag)) &&
    targets.some(isWipeTarget)
  ) {
    return 'changes permissions of the system or your home directory';
  }
  return null;
}

/** True for `/`, the home directory, a system directory, or an unexpanded variable. */
function isWipeTarget(target: string): boolean {
  if (target.startsWith('$')) return true;
  const home = os.homedir();
  const resolved = path.resolve(expandHome(target.replace(/\/\*$/, '') || '/'));
  return resolved === path.parse(resolved).root || resolved === home || isSystemPath(resolved);
}

/** True when writing `file` would change a system directory or the user's credentials. */
function isProtectedPath(file: string, worktree: string): boolean {
  if (file === '/dev/null') return false;
  const resolved = path.resolve(worktree, expandHome(file));
  const home = os.homedir();
  return (
    isSystemPath(resolved) ||
    PROTECTED_HOME.some((entry) => isInside(resolved, path.join(home, entry)))
  );
}

function isSystemPath(resolved: string): boolean {
  const file = comparable(resolved);
  return SYSTEM_DIRS.some((dir) => file === dir || file.startsWith(`${dir}/`));
}

/**
 * `resolved` with forward slashes, no drive letter and in lower case, so one list matches on
 * every OS: on Windows `/etc` resolves to `C:\etc` and system folders differ only in case.
 */
function comparable(resolved: string): string {
  return resolved
    .replace(/\\/g, '/')
    .replace(/^[a-z]:/i, '')
    .toLowerCase();
}

function isInside(file: string, dir: string): boolean {
  return file === dir || file.startsWith(`${dir}${path.sep}`);
}

function expandHome(file: string): string {
  if (file === '~') return os.homedir();
  return file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
}

/** True when `file` (relative to `worktree` unless absolute; `~` is home) lies outside it. */
function outside(file: string, worktree: string): boolean {
  if (file.startsWith('~')) return true;
  const resolved = path.resolve(worktree, file);
  const relative = path.relative(path.resolve(worktree), resolved);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
