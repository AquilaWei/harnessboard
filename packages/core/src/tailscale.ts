// SPDX-License-Identifier: Apache-2.0
import { output } from './process.js';

/** Runs a command and resolves with its stdout; rejects when it is missing or fails. */
export type CommandRunner = (command: string, args: string[]) => Promise<string>;

/** The parts of `tailscale status --json` that are read. */
interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string };
}

/**
 * This machine's name in the tailnet (e.g. `pc.tailnet.ts.net`), which a phone uses to reach
 * the board through `tailscale serve`. Resolves with `null` when Tailscale is not installed,
 * not running or not logged in, or prints something unexpected: phone access is optional, so
 * none of these is an error. Nothing is started or changed.
 */
export async function tailscaleHost(run: CommandRunner = output): Promise<string | null> {
  let status: TailscaleStatus;
  try {
    status = JSON.parse(await run('tailscale', ['status', '--json'])) as TailscaleStatus;
  } catch {
    return null;
  }
  if (status.BackendState !== 'Running') return null;
  // The name is fully qualified, with a trailing dot that a Host header never has.
  const name = status.Self?.DNSName?.replace(/\.$/, '') ?? '';
  return name === '' ? null : name;
}
