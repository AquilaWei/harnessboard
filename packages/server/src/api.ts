// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { inspectFolder, listFolders } from '@harnessboard/core';
import type { EditableSettings, Harness } from '@harnessboard/core';
import type {
  AgentsUpdate,
  CreateTaskInput,
  DeletedTask,
  HarnessEvent,
  NewAgentProfile,
  PermissionDecision,
  VersionInfo,
} from '@harnessboard/shared';
import pkg from '../package.json' with { type: 'json' };
import { chatTranscript, latestSnapshot, planView, taskView, timeline } from './views.js';

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
  // The server's version: with the desktop app attached to an `hb serve`, this is that server's.
  app.get('/version', (c) => c.json({ version: pkg.version } satisfies VersionInfo));

  // Read-only: folder names on this machine, for picking a repository in the web UI.
  app.get('/folders', async (c) => c.json(await listFolders(c.req.query('path'))));
  app.get('/folders/inspect', async (c) => c.json(await inspectFolder(c.req.query('path') ?? '')));

  app.get('/agents', async (c) => c.json(await harness.probeAgents()));
  app.get('/agents/detect', async (c) => c.json(await harness.detectAgents()));
  app.get('/agents/:id/models', async (c) => c.json(await harness.models(c.req.param('id'))));
  app.post('/agents', async (c) =>
    c.json(harness.addAgent(await c.req.json<NewAgentProfile>()), 201),
  );

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

  app.post('/tasks/:id/permission', async (c) => {
    const body = await c.req.json<Partial<PermissionDecision>>();
    if (typeof body.requestId !== 'string' || !['allow', 'deny'].includes(body.behavior ?? '')) {
      throw new Error('send a requestId and a behavior of "allow" or "deny"');
    }
    if (
      body.rules !== undefined &&
      !(Array.isArray(body.rules) && body.rules.every((r) => typeof r === 'string'))
    ) {
      throw new Error('rules must be a list of strings');
    }
    const decision: PermissionDecision = {
      requestId: body.requestId,
      behavior: body.behavior!,
      ...(body.rules ? { rules: body.rules } : {}),
      ...(body.scope === 'global' ? { scope: 'global' as const } : {}),
      ...(typeof body.message === 'string' ? { message: body.message } : {}),
    };
    return c.json(harness.answerPermission(taskId(c), decision));
  });

  app.put('/tasks/:id/agents', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const update: AgentsUpdate = {};
    if (typeof body.implementer === 'string') update.implementer = body.implementer;
    if (typeof body.reviewer === 'string' || body.reviewer === null)
      update.reviewer = body.reviewer;
    if (typeof body.spec === 'string' || body.spec === null) update.spec = body.spec;
    if (typeof body.tester === 'string' || body.tester === null) update.tester = body.tester;
    for (const key of ['implementerModel', 'reviewerModel', 'specModel', 'testerModel'] as const) {
      const value = body[key];
      if (typeof value === 'string' || value === null) update[key] = value;
    }
    return c.json(harness.setAgents(taskId(c), update));
  });

  app.put('/tasks/:id/auto-approve', async (c) => {
    const { on } = await c.req.json<{ on?: unknown }>();
    if (typeof on !== 'boolean') throw new Error('send { "on": true } or { "on": false }');
    return c.json(harness.setAutoApprove(taskId(c), on));
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

  app.post('/tasks/:id/criteria/approve', async (c) => {
    const body = await c.req.json<{ criteria?: string }>().catch(() => ({}));
    return c.json(harness.approveCriteria(taskId(c), (body as { criteria?: string }).criteria));
  });

  app.get('/tasks/:id/chat', (c) => c.json(chatTranscript(taskId(c), harness.store)));
  app.post('/tasks/:id/chat', async (c) => {
    const { message } = await c.req.json<{ message: string }>();
    return c.json(harness.chat(taskId(c), message));
  });
  app.delete('/tasks/:id/chat/pending', (c) => c.json(harness.cancelChat(taskId(c))));

  app.post('/tasks/:id/merge', async (c) => c.json(await harness.mergeTask(taskId(c))));

  app.get('/tasks/:id/timeline', (c) => c.json(timeline(taskId(c), harness.store)));

  app.get('/tasks/:id/notes', (c) => c.json(harness.notes(taskId(c))));

  app.get('/tasks/:id/commits', async (c) => c.json(await harness.commits(taskId(c))));
  app.get('/tasks/:id/commits/:hash', async (c) =>
    c.json({ show: await harness.commitDiff(taskId(c), c.req.param('hash')) }),
  );

  app.get('/tasks/:id/diff', async (c) => c.json(await harness.diff(taskId(c))));

  app.get('/events', (c) => {
    const only = c.req.query('task');
    return streamSSE(c, async (stream) => {
      const unsubscribe = harness.subscribe((event: HarnessEvent) => {
        // A task's stream carries only that task's events, not account-wide ones like quota.
        if (only && !('taskId' in event && String(event.taskId) === only)) return;
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
