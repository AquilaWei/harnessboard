// SPDX-License-Identifier: Apache-2.0
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Harness, userConfigFile } from '@harnessboard/core';
import type { HarnessConfig } from '@harnessboard/core';
import type { AgentInfo, DetectedAgent } from '@harnessboard/shared';
import { access } from './access.js';
import { createApi } from './api.js';
import { Sessions } from './session.js';
import { serveWeb } from './static.js';

// The bundled CLI lives in dist/; the web build is copied next to it in dist/web.
const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

export interface RunningServer {
  url: string;
  /** Each agent profile's CLI version, or why it could not run (its tasks fail until fixed). */
  agents: AgentInfo[];
  /** Agent CLIs found on this machine, with or without a profile. */
  detected: DetectedAgent[];
  close(): Promise<void>;
}

/**
 * Starts the scheduler and the HTTP API on 127.0.0.1 only.
 * Rejects when the port is already in use (usually another harnessboard server).
 */
export async function startServer(config: HarnessConfig): Promise<RunningServer> {
  const harness = Harness.open(config, { settingsFile: userConfigFile() });
  const [agents, detected] = await Promise.all([harness.probeAgents(), harness.detectAgents()]);
  const app = new Hono();
  const sessions = new Sessions();
  app.use('*', access(harness, sessions));
  app.route('/api', createApi(harness, sessions));
  app.get('*', serveWeb(WEB_ROOT));

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, () =>
      resolve(s),
    );
    s.once('error', reject);
  });
  await harness.start();
  return {
    url: `http://127.0.0.1:${config.port}`,
    agents,
    detected,
    close: async () => {
      await harness.shutdown();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Open SSE streams would otherwise keep close() waiting forever.
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
      harness.store.close();
    },
  };
}
