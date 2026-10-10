// SPDX-License-Identifier: Apache-2.0
import { output, spawnLines } from './process.js';

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

/**
 * Where Tailscale stands on this computer, in the order it has to be fixed:
 * `missing` (not installed), `stopped` (installed, but its background service is not running),
 * `needs-login` (running, but logged out or switched off with `tailscale down`), or `running`.
 */
export type TailscaleState = 'missing' | 'stopped' | 'needs-login' | 'running';

/** Reads {@link TailscaleState} from `tailscale status --json`; nothing is started or changed. */
export async function tailscaleState(run: CommandRunner = output): Promise<TailscaleState> {
  let out: string;
  try {
    out = await run('tailscale', ['status', '--json']);
  } catch (err) {
    // The command exits non-zero when it cannot reach the service, which is the usual failure.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' || /ENOENT/.test((err as Error).message)
      ? 'missing'
      : 'stopped';
  }
  try {
    const backend = (JSON.parse(out) as TailscaleStatus).BackendState;
    return backend === 'Running' ? 'running' : 'needs-login';
  } catch {
    return 'stopped';
  }
}

/** What {@link startTailscale} achieved. */
export interface TailscaleStartResult {
  state: TailscaleState;
  /** Where to log in, when Tailscale is waiting for it; open it in a browser. */
  loginUrl?: string;
}

/** Starts and logs in Tailscale; split out so tests can fake the privileged and long-running parts. */
export interface TailscaleStarter {
  run: CommandRunner;
  /** Runs `tailscale up` and resolves with the login address it prints, or `null` if it finished. */
  up: () => Promise<string | null>;
}

const LOGIN_URL = /https:\/\/\S+/;
/** How long `tailscale up` may wait for the user to log in before it is stopped. */
const LOGIN_WAIT_MS = 5 * 60_000;

function runUp(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let url: string | null = null;
    const found = (line: string) => {
      url ??= LOGIN_URL.exec(line)?.[0] ?? null;
      if (url) resolve(url);
    };
    const child = spawnLines('tailscale', ['up'], process.cwd(), found, found);
    // Left running while the user logs in; it ends by itself once they have.
    const timer = setTimeout(() => child.kill(), LOGIN_WAIT_MS);
    timer.unref();
    child.exited.then((code) => {
      clearTimeout(timer);
      if (code === 0) resolve(null);
      else
        reject(
          new Error(
            `tailscale up exited with code ${code}; if it says access denied, run "sudo tailscale set --operator=$USER" once`,
          ),
        );
    }, reject);
  });
}

/**
 * Brings Tailscale up as far as it can without the user typing in a terminal. On Linux it asks
 * the desktop's password prompt (`pkexec`) to start and enable the `tailscaled` service, which
 * needs root; then it runs `tailscale up`, whose login address is returned for the user to open.
 * Rejects with the reason when a step fails (no `pkexec`, prompt cancelled, not permitted).
 */
export async function startTailscale(
  platform: NodeJS.Platform = process.platform,
  starter: TailscaleStarter = { run: output, up: runUp },
): Promise<TailscaleStartResult> {
  let state = await tailscaleState(starter.run);
  if (state === 'missing') return { state };
  if (state === 'stopped') {
    if (platform !== 'linux') return { state };
    await starter.run('pkexec', ['systemctl', 'enable', '--now', 'tailscaled']);
    state = await tailscaleState(starter.run);
  }
  if (state === 'needs-login') {
    const loginUrl = await starter.up();
    return loginUrl ? { state, loginUrl } : { state: await tailscaleState(starter.run) };
  }
  return { state };
}
