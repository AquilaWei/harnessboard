// SPDX-License-Identifier: Apache-2.0
// An app started from the Dock, Finder or a desktop launcher does not get the PATH the user's
// shell sets up, so `claude`, `codex` or `git` installed in ~/.local/bin or by Homebrew would
// not be found. The PATH is read once from a login shell instead.
import { execFile } from 'node:child_process';

/** Wraps the PATH in the shell's output, since startup files may print their own text. */
const MARK = '__HARNESSBOARD_PATH__';

/** The command a login shell runs to print its PATH between two marks. */
export const PRINT_PATH = `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`;

/** The PATH between the marks; `null` when the output has none. */
export function pathFromShellOutput(output: string): string | null {
  const parts = output.split(MARK);
  if (parts.length < 3) return null;
  const value = parts[1]!.trim();
  return value === '' ? null : value;
}

/** The shell's entries first, then any entry of `current` the shell does not have. */
export function mergePaths(shell: string, current: string, delimiter: string): string {
  const entries = shell.split(delimiter).filter((e) => e !== '');
  const seen = new Set(entries);
  for (const entry of current.split(delimiter)) {
    if (entry !== '' && !seen.has(entry)) {
      entries.push(entry);
      seen.add(entry);
    }
  }
  return entries.join(delimiter);
}

/**
 * PATH as an interactive login `shell` sets it, or `null` when the shell fails, prints no
 * PATH or takes longer than `timeoutMs` (a startup file waiting for input, for example).
 */
export function loginShellPath(shell: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', PRINT_PATH], { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : pathFromShellOutput(stdout));
    });
  });
}
