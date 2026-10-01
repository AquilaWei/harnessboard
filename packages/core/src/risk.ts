// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';

/** Shell commands auto-approve never allows on its own, with the reason shown to the user. */
const RISKY_COMMANDS: [RegExp, string][] = [
  [/\bsudo\b/, 'runs as root (sudo)'],
  [/\bgit\s+push\b/, 'pushes to a remote (git push)'],
  [
    /\bgit\s+(reset\s+--hard|clean\b|rebase\b|filter-branch\b|branch\s+-D\b|checkout\s+--\s|restore\b)/,
    'discards or rewrites git work',
  ],
  [/\brm\s+(-\w*[rR]\w*|--recursive)\b/, 'deletes recursively (rm -r)'],
  [/\b(curl|wget|ssh|scp|rsync|ftp|nc|ncat|telnet)\b/, 'uses the network'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/, 'publishes a package'],
  [/\b(chmod|chown)\s+-R\b/, 'changes permissions recursively'],
  [/\bmkfs\b|\bdd\s+[^|;&]*\bof=/, 'writes to a disk'],
  [/\b(shutdown|reboot|kill|pkill|killall)\b/, 'stops processes or the machine'],
  [/\bdocker\b|\bpodman\b/, 'runs containers, which can reach the whole machine'],
];

/** Tools that write a file named in their input. */
const FILE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/**
 * Why a tool use is too risky to allow without asking in auto-approve mode, or `null` when
 * it may be allowed. `worktree` is the task's directory; anything written outside it is
 * risky. A blocklist cannot catch everything, so this is a convenience, not a sandbox.
 */
export function riskOf(toolName: string, input: unknown, worktree: string): string | null {
  const fields = (input ?? {}) as Record<string, unknown>;
  if (toolName.startsWith('mcp__')) return 'is an MCP tool, whose effects are unknown';
  const fileField = FILE_TOOLS[toolName];
  if (fileField) {
    const file = fields[fileField];
    if (typeof file !== 'string') return 'writes a file it does not name';
    return outside(file, worktree) ? "writes outside the task's worktree" : null;
  }
  if (toolName !== 'Bash') return null;
  const command = typeof fields.command === 'string' ? fields.command : '';
  for (const [pattern, reason] of RISKY_COMMANDS) {
    if (pattern.test(command)) return reason;
  }
  for (const match of command.matchAll(/(?:^|[^<>&\d])>>?\s*([^\s;&|]+)/g)) {
    const target = match[1]!;
    if (target !== '/dev/null' && !target.startsWith('&') && outside(target, worktree)) {
      return "writes outside the task's worktree";
    }
  }
  if (/(^|[\s;&|])cd\s+(\/|~|\.\.)/.test(command)) return "leaves the task's worktree (cd)";
  return null;
}

/** True when `file` (relative to `worktree` unless absolute; `~` is home) lies outside it. */
function outside(file: string, worktree: string): boolean {
  if (file.startsWith('~')) return true;
  const resolved = path.resolve(worktree, file);
  const relative = path.relative(path.resolve(worktree), resolved);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
