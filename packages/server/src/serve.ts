// SPDX-License-Identifier: Apache-2.0
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ClaudeCodeAdapter, Harness, probe, userConfigFile } from '@harnessboard/core';
import type { HarnessConfig } from '@harnessboard/core';
import { createApi, localOnly } from './api.js';

export interface RunningServer {
  url: string;
  /** Agent CLI version, or the reason it could not be run (tasks will fail until fixed). */
  agent: { ok: true; version: string } | { ok: false; error: string };
  close(): Promise<void>;
}

/**
 * Starts the scheduler and the HTTP API on 127.0.0.1 only.
 * Rejects when the port is already in use (usually another harnessboard server).
 */
export async function startServer(config: HarnessConfig): Promise<RunningServer> {
  const adapter = new ClaudeCodeAdapter(config.claudePath);
  const agent = await probe(adapter.command, adapter.versionArgs).then(
    (version) => ({ ok: true as const, version }),
    (err: Error) => ({ ok: false as const, error: err.message }),
  );
  const harness = Harness.open(config, adapter, userConfigFile());
  const app = new Hono();
  app.use('*', localOnly(config.port));
  app.route('/api', createApi(harness));

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, () =>
      resolve(s),
    );
    s.once('error', reject);
  });
  harness.start();
  return {
    url: `http://127.0.0.1:${config.port}`,
    agent,
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
