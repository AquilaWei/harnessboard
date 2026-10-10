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
 * Lets the tailnet (never the public internet) reach the board on `port` through
 * `tailscale serve --bg`. Does nothing when `tailscale serve status` already proxies the port.
 * Rejects when Tailscale cannot do it, e.g. HTTPS certificates are off in the admin console or
 * this user may not change Tailscale's settings; the message says how to see the reason.
 */
export async function tailscaleServe(port: number, run: CommandRunner = output): Promise<void> {
  try {
    const status = await run('tailscale', ['serve', 'status', '--json']);
    if (status.includes(`127.0.0.1:${port}`) || status.includes(`localhost:${port}`)) return;
    await run('tailscale', ['serve', '--bg', String(port)]);
  } catch (err) {
    throw new Error(
      `tailscale could not serve the board (${(err as Error).message}); ` +
        `run "tailscale serve --bg ${port}" in a terminal to see why`,
      { cause: err },
    );
  }
}

/**
 * This machine's name in the tailnet (e.g. `pc.tailnet.ts.net`), which a phone uses to reach
 * the board through `tailscale serve` ({@link tailscaleServe}). Resolves with `null` when Tailscale is not installed,
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
