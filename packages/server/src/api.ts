// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { inspectFolder, listFolders } from '@harnessboard/core';
import type { EditableSettings, Harness } from '@harnessboard/core';
import type { CreateTaskInput, DeletedTask, HarnessEvent } from '@harnessboard/shared';
import { latestSnapshot, planView, taskView, timeline } from './views.js';

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
  const view = (id: number) => {
    const task = harness.store.getTask(id);
    return task ? taskView(task, harness) : undefined;
  };

  app.onError((err, c) => c.json({ error: err.message }, 400));

  app.get('/status', (c) => c.json(harness.status()));

  // Read-only: folder names on this machine, for picking a repository in the web UI.
  app.get('/folders', async (c) => c.json(await listFolders(c.req.query('path'))));
  app.get('/folders/inspect', async (c) => c.json(await inspectFolder(c.req.query('path') ?? '')));

  app.get('/agents', async (c) => c.json(await harness.probeAgents()));

  app.get('/settings', (c) => c.json(harness.settings()));
  app.put('/settings', async (c) =>
    c.json(harness.updateSettings(await c.req.json<Partial<EditableSettings>>())),
  );

  app.get('/tasks', (c) => c.json(harness.store.listTasks().map((t) => taskView(t, harness))));

  app.post('/tasks', async (c) => {
    const task = await harness.createTask(await c.req.json<CreateTaskInput>());
    return c.json(view(task.id), 201);
  });

  app.get('/tasks/:id', (c) => {
    const id = taskId(c);
    const task = view(id);
    if (!task) return c.json({ error: `task ${id} not found` }, 404);
    return c.json({
      ...task,
      sessions: harness.store.listSessions(id),
      features: latestSnapshot(harness.store, id)?.features ?? null,
    });
  });

  // The branch is kept; it is returned so the caller can tell the user where the work is.
  app.delete('/tasks/:id', async (c) => {
    const id = taskId(c);
    const task = harness.store.getTask(id);
    if (!task) return c.json({ error: `task ${id} not found` }, 404);
    await harness.deleteTask(id);
    const reply: DeletedTask = { id, branch: task.branch };
    return c.json(reply);
  });

  app.put('/tasks/:id/allowed-tools', async (c) => {
    const { rules } = await c.req.json<{ rules?: unknown }>();
    if (!Array.isArray(rules) || !rules.every((r) => typeof r === 'string')) {
      throw new Error('rules must be a list of strings');
    }
    return c.json(harness.setAllowedTools(taskId(c), rules));
  });

  app.post('/tasks/:id/queue', (c) => c.json(harness.queueTask(taskId(c))));
  app.post('/tasks/:id/stop', (c) => c.json(harness.stopTask(taskId(c))));
  app.post('/tasks/:id/complete', (c) => c.json(harness.completeTask(taskId(c))));

  app.get('/tasks/:id/events', (c) => {
    const after = Number(c.req.query('after') ?? 0);
    return c.json(harness.store.listEvents(taskId(c), after));
  });

  app.get('/tasks/:id/plan', (c) => {
    const id = taskId(c);
    const task = harness.store.getTask(id);
    if (!task) return c.json({ error: `task ${id} not found` }, 404);
    return c.json(planView(task, harness.store));
  });
  app.post('/tasks/:id/plan/feedback', async (c) => {
    const { message } = await c.req.json<{ message: string }>();
    return c.json(harness.planFeedback(taskId(c), message ?? ''));
  });
  app.post('/tasks/:id/plan/approve', async (c) => {
    const body = await c.req.json<{ verifyCommand?: string }>().catch(() => ({}));
    return c.json(
      harness.approvePlan(taskId(c), (body as { verifyCommand?: string }).verifyCommand),
    );
  });

  app.get('/tasks/:id/timeline', (c) => c.json(timeline(taskId(c), harness.store)));

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
