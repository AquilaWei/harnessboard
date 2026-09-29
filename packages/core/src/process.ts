// SPDX-License-Identifier: Apache-2.0
import { createInterface } from 'node:readline';
import spawn from 'cross-spawn';
import treeKill from 'tree-kill';

export interface ChildHandle {
  write(data: string): void;
  closeInput(): void;
  /** Kills the whole process tree (the agent spawns shells and tools of its own). */
  kill(): void;
  /** Resolves with the exit code, or `null` when killed by a signal. */
  readonly exited: Promise<number | null>;
}

/**
 * Spawns a line-oriented child process. `cross-spawn` handles `.cmd` shims and
 * shebang scripts on Windows, where plain `child_process.spawn` fails on them.
 */
export function spawnLines(
  command: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
  onStderr: (line: string) => void,
): ChildHandle {
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  createInterface({ input: child.stdout! }).on('line', onLine);
  createInterface({ input: child.stderr! }).on('line', onStderr);
  // Writes after the child exits would otherwise raise an unhandled EPIPE.
  child.stdin!.on('error', () => {});
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  return {
    write: (data) => {
      if (!child.stdin!.destroyed) child.stdin!.write(data);
    },
    closeInput: () => child.stdin!.end(),
    kill: () => {
      if (child.pid !== undefined && child.exitCode === null) treeKill(child.pid);
    },
    exited,
  };
}
