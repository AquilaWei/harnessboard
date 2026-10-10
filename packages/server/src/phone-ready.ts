// SPDX-License-Identifier: Apache-2.0
/** How long to wait before trying again after Tailscale was missing or refused to serve. */
const RETRY_MS = 5 * 60_000;

export interface PhoneReadyDeps {
  /** Whether any phone is paired; with none, nothing is exposed until the user clicks Pair. */
  hasDevices: () => boolean;
  detect: () => Promise<string | null>;
  serve: (port: number) => Promise<void>;
  log: (message: string) => void;
}

/**
 * Keeps the board reachable on the tailnet for phones that are already paired, so they connect
 * as soon as Harnessboard runs, without opening Settings. Tries once now and then every five
 * minutes until it succeeds (Tailscale may start later, or its sharing may have been reset).
 * Failures are only logged: phone access is optional. Returns a function that stops the retries.
 */
export function keepPhoneReady(port: number, deps: PhoneReadyDeps): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const attempt = async (): Promise<void> => {
    if (stopped || !deps.hasDevices()) return;
    try {
      if ((await deps.detect()) !== null) {
        await deps.serve(port);
        return;
      }
    } catch (err) {
      deps.log(`Phone access: ${(err as Error).message}`);
    }
    if (!stopped) {
      timer = setTimeout(() => void attempt(), RETRY_MS);
      timer.unref();
    }
  };

  void attempt();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
