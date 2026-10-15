// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Points the system temp folder at a fresh folder for this run and deletes it afterwards.
 * The tests make hundreds of temp folders (repositories, homes, worktrees) and leave them
 * behind; without this they pile up in /tmp until it runs out of inodes and every test fails
 * with ENOSPC. Worker processes are started after this runs, so they inherit the variables.
 * Codex's home is moved there too: a harness reads the account's usage from it, and the
 * user's own nearly used-up quota would pause the tests' Codex sessions.
 */
export default function setup(): () => void {
  const runDir = mkdtempSync(path.join(tmpdir(), 'hb-test-run-'));
  // os.tmpdir() reads TMPDIR on POSIX and TEMP / TMP on Windows.
  process.env.TMPDIR = runDir;
  process.env.TEMP = runDir;
  process.env.TMP = runDir;
  process.env.CODEX_HOME = path.join(runDir, 'codex-home');
  return () => {
    rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
  };
}
