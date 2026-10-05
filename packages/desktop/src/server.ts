// SPDX-License-Identifier: Apache-2.0
// Finding, waiting for and stopping the local server. Nothing here needs Electron, so the
// decisions are tested with plain HTTP servers and fake processes.

/** What answers on the server's port: Harnessboard, another program, or nothing. */
export type PortState = 'harnessboard' | 'other' | 'free';

/** Header the API requires from its clients (see `access` in the server). */
const CLIENT_HEADER = { 'x-harnessboard-client': 'desktop' };

/**
 * Asks `url` for Harnessboard's settings. A server started from a terminal (`hb serve`) is
 * used as it is, so the app and the CLI never run two schedulers on one database.
 */
export async function probePort(url: string, timeoutMs = 2000): Promise<PortState> {
  let response: Response;
  try {
    response = await fetch(`${url}/api/settings`, {
      headers: CLIENT_HEADER,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return 'free';
  }
  if (!response.ok) return 'other';
  try {
    const body = (await response.json()) as { maxConcurrent?: unknown };
    return typeof body.maxConcurrent === 'number' ? 'harnessboard' : 'other';
  } catch {
    return 'other';
  }
}

/**
 * Waits until Harnessboard answers at `url`. Resolves `false` when `exited` settles first
 * (the server could not start) or after `timeoutMs`.
 */
export async function waitForServer(
  url: string,
  exited: Promise<unknown>,
  timeoutMs = 60_000,
  intervalMs = 250,
): Promise<boolean> {
  let gone = false;
  void exited.then(() => (gone = true));
  const deadline = Date.now() + timeoutMs;
  while (!gone && Date.now() < deadline) {
    if ((await probePort(url, intervalMs * 4)) === 'harnessboard') return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** The parts of Electron's `UtilityProcess` that stopping the server needs. */
export interface ServerProcess {
  postMessage(message: unknown): void;
  kill(): boolean;
}

/** Message the server's desktop entry stops on (`SHUTDOWN_MESSAGE` in the server). */
export const SHUTDOWN_MESSAGE = 'shutdown';

/**
 * Asks the server to finish (it stops running agents and closes the database) and kills it
 * when it has not exited after `timeoutMs`. Resolves `true` when it exited by itself.
 */
export async function stopServer(
  child: ServerProcess,
  exited: Promise<unknown>,
  timeoutMs = 10_000,
): Promise<boolean> {
  child.postMessage(SHUTDOWN_MESSAGE);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const clean = await Promise.race([exited.then(() => true as const), timedOut]);
  clearTimeout(timer);
  if (!clean) child.kill();
  return clean;
}
