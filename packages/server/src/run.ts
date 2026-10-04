// SPDX-License-Identifier: Apache-2.0
import { userConfigFile } from '@harnessboard/core';
import type { HarnessConfig } from '@harnessboard/core';
import type { DetectedAgent } from '@harnessboard/shared';
import { t } from './i18n.js';
import { startServer } from './serve.js';
import pkg from '../package.json' with { type: 'json' };

/** Message the desktop app sends over Electron's parent port to stop the server. */
export const SHUTDOWN_MESSAGE = 'shutdown';

/** The parent port Electron gives a utility process; absent under plain Node. */
interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

/**
 * Starts the server, prints the agents it found and its address, and closes it cleanly on
 * SIGINT, SIGTERM or a shutdown message from the desktop app (Windows has no SIGTERM for a
 * child process). Rejects when the server can not start, for example when the port is taken.
 */
export async function runServer(config: HarnessConfig): Promise<void> {
  const server = await startServer(config);
  for (const agent of server.agents) {
    const vars = { id: agent.id, command: agent.profile.command, file: userConfigFile() };
    if (agent.ok) console.log(t('agentFound', { ...vars, version: agent.version ?? '' }));
    else console.warn(t('agentMissing', { ...vars, error: agent.error ?? '' }));
  }
  printUnconfigured(server.detected);
  console.log(t('serverStarted', { version: `v${pkg.version}`, url: server.url }));
  const shutdown = () => void server.close().then(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const parentPort = (process as { parentPort?: ParentPort }).parentPort;
  parentPort?.on('message', (event) => {
    if (event.data === SHUTDOWN_MESSAGE) shutdown();
  });
}

/** Points out agent CLIs found on this machine that no profile uses yet. */
export function printUnconfigured(detected: DetectedAgent[]): void {
  for (const d of detected) {
    if (d.profileId !== null) continue;
    console.log(
      t('agentDetected', { command: d.command, version: d.version, provider: d.provider }),
    );
  }
}
