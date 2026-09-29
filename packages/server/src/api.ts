// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { EditableSettings, Harness } from '@harnessboard/core';
import type { CreateTaskInput, HarnessEvent } from '@harnessboard/shared';
import { taskView } from './views.js';

/** Header every state-changing request must carry; see {@link localOnly}. */
export const CLIENT_HEADER = 'x-harnessboard-client';

/**
 * The API can start agents that edit files and run commands, so it must only be reachable
 * from this machine's own tools:
 * - the Host header must be a loopback name, which defeats DNS rebinding;
 * - non-GET requests need {@link CLIENT_HEADER}. Browsers cannot add a custom header to a
 *   cross-origin request without a CORS preflight, which this server never approves.
 */
export function localOnly(port: number): MiddlewareHandler {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  return async (c, next) => {
    if (!allowedHosts.has(c.req.header('host') ?? '')) return c.text('forbidden host', 403);
    if (c.req.method !== 'GET' && !c.req.header(CLIENT_HEADER)) {
      return c.text(`missing ${CLIENT_HEADER} header`, 403);
    }
    await next();
  };
}

export function createApi(harness: Harness): Hono {
  const app = new Hono();
  const fallback = harness.config.fallbackContextWindow;
  const view = (id: number) => {
    const task = harness.store.getTask(id);
    return task ? taskView(task, harness.store, fallback) : undefined;
  };

  app.onError((err, c) => c.json({ error: err.message }, 400));

  app.get('/status', (c) => c.json(harness.status()));

  app.get('/settings', (c) => c.json(harness.settings()));
  app.put('/settings', async (c) =>
    c.json(harness.updateSettings(await c.req.json<Partial<EditableSettings>>())),
  );

  app.get('/tasks', (c) =>
    c.json(harness.store.listTasks().map((t) => taskView(t, harness.store, fallback))),
  );

  app.post('/tasks', async (c) => {
    const task = await harness.createTask(await c.req.json<CreateTaskInput>());
    return c.json(view(task.id), 201);
  });

  app.get('/tasks/:id', (c) => {
    const id = taskId(c);
    const task = view(id);
    if (!task) return c.json({ error: `task ${id} not found` }, 404);
    return c.json({ ...task, sessions: harness.store.listSessions(id) });
  });

  app.post('/tasks/:id/queue', (c) => c.json(harness.queueTask(taskId(c))));
  app.post('/tasks/:id/stop', (c) => c.json(harness.stopTask(taskId(c))));
  app.post('/tasks/:id/complete', (c) => c.json(harness.completeTask(taskId(c))));

  app.get('/tasks/:id/events', (c) => {
    const after = Number(c.req.query('after') ?? 0);
    return c.json(harness.store.listEvents(taskId(c), after));
  });

  app.get('/tasks/:id/diff', async (c) => c.json(await harness.diff(taskId(c))));

  app.get('/events', (c) => {
    const only = c.req.query('task');
    return streamSSE(c, async (stream) => {
      const unsubscribe = harness.subscribe((event: HarnessEvent) => {
        if (only && String(event.taskId) !== only) return;
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      });
      stream.onAbort(unsubscribe);
      // Keep the connection open until the client goes away; ping so proxies don't time out.
      while (!stream.aborted) {
        await stream.writeSSE({ event: 'ping', data: '' });
        await stream.sleep(15_000);
      }
      unsubscribe();
    });
  });

  return app;
}

function taskId(c: Context): number {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid task id: ${c.req.param('id')}`);
  return id;
}
