// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { inspectFolder, listFolders, tailscaleHost } from '@harnessboard/core';
import type { EditableSettings, Harness } from '@harnessboard/core';
import type {
  AgentsUpdate,
  CreateTaskInput,
  DeletedTask,
  HarnessEvent,
  NewAgentProfile,
  PairRequest,
  PairingSetup,
  PasskeySession,
  PermissionDecision,
  PushKey,
  VersionInfo,
} from '@harnessboard/shared';
import pkg from '../package.json' with { type: 'json' };
import { DEVICE_COOKIE } from './access.js';
import type { AccessEnv } from './access.js';
import { Pairing, newDeviceToken } from './pairing.js';
import { Passkeys, webauthnVerifier } from './passkey.js';
import type { Party, PasskeyResult, PasskeyVerifier } from './passkey.js';
import { PushNotifier, loadVapidKeys, parseSubscription, webPushSender } from './push.js';
import type { PushSender, VapidKeys } from './push.js';
import type { Sessions } from './session.js';
import { chatTranscript, latestSnapshot, planView, taskView, timeline } from './views.js';

/** A device cookie lasts a year; revoking the device ends it sooner. */
const DEVICE_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

/** Longest device name accepted, so the device list stays readable. */
const MAX_DEVICE_NAME = 64;

/** Status code and message for each refused passkey step. */
const PASSKEY_REFUSALS = {
  'has-passkey': [409, 'this device already has a passkey'],
  'too-late': [403, 'too long since pairing; pair this device again'],
  'no-passkey': [409, 'this device has no passkey yet; pair it again'],
  invalid: [400, 'the passkey could not be verified'],
  blocked: [429, 'too many failed passkey checks; try again later'],
} as const;

/** What {@link createApi} talks to outside the harness; tests swap these for fakes. */
export interface ApiDeps {
  /** Clock for pairing codes, passkey challenges and lock times. */
  now: () => number;
  /** Finds this machine's Tailscale name, so tests do not depend on whether it runs Tailscale. */
  detectTailscale: () => Promise<string | null>;
  /** Checks passkeys; tests fake the phone's signed responses. */
  verifier: PasskeyVerifier;
  /** Delivers pushes to paired phones; tests record them instead. */
  pushSender: PushSender;
}

/**
 * The HTTP API, mounted under `/api`. Who may reach it is decided by `access` in access.ts, which
 * must be given the same `sessions`: the passkey routes open them, `access` checks them.
 */
export function createApi(
  harness: Harness,
  sessions: Sessions,
  deps: Partial<ApiDeps> = {},
): Hono<AccessEnv> {
  const {
    now = Date.now,
    detectTailscale = () => tailscaleHost(),
    verifier = webauthnVerifier,
    pushSender = webPushSender,
  } = deps;
  const app = new Hono<AccessEnv>();
  const pairing = new Pairing(now);
  const passkeys = new Passkeys(harness.store, verifier, now);
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

  // Pairing a phone: the computer makes a code (shown as a QR code), the phone sends it back.
  app.post('/pairing', (c) => c.json(pairing.create(), 201));
  // What the settings dialog needs to explain phone access; under /pairing so it stays local.
  app.get('/pairing/setup', async (c) =>
    c.json({
      tailscaleHost: await detectTailscale(),
      port: harness.config.port,
    } satisfies PairingSetup),
  );
  app.post('/pair', async (c) => {
    const body = await c.req.json<Partial<PairRequest>>().catch(() => ({}) as Partial<PairRequest>);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (typeof body.code !== 'string' || !name || name.length > MAX_DEVICE_NAME) {
      throw new Error(`send a code and a device name of 1 to ${MAX_DEVICE_NAME} characters`);
    }
    const result = pairing.redeem(body.code);
    if (result === 'blocked') {
      return c.json({ error: 'too many failed attempts; show a new pairing code' }, 429);
    }
    if (result === 'invalid') {
      return c.json({ error: 'this pairing code is wrong, expired or already used' }, 400);
    }
    const token = newDeviceToken();
    const device = harness.store.addDevice(name, token, now());
    setCookie(c, DEVICE_COOKIE, token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      maxAge: DEVICE_COOKIE_MAX_AGE_S,
    });
    return c.json(device, 201);
  });
  // Right after pairing the phone registers a passkey; until then the device can do nothing else.
  app.post('/passkey/options', async (c) =>
    passkeyReply(c, await passkeys.registrationOptions(remoteDevice(c), party(c))),
  );
  // Registering requires the same user verification as a check, so it also starts a session.
  app.post('/passkey', async (c) => {
    const device = remoteDevice(c);
    const result = await passkeys.register(device, party(c), await c.req.json());
    return result.ok ? sessionReply(c, sessions, device.id) : passkeyReply(c, result);
  });
  // The passkey check: a challenge for the device's own passkey, then the phone's signed answer.
  app.post('/auth/challenge', async (c) =>
    passkeyReply(c, await passkeys.authenticationOptions(remoteDevice(c), party(c))),
  );
  app.post('/auth/verify', async (c) => {
    const device = remoteDevice(c);
    const result = await passkeys.verify(device, party(c), await c.req.json());
    return result.ok ? sessionReply(c, sessions, device.id) : passkeyReply(c, result);
  });

  // Web Push for a paired phone. The keys are made on the first request, not at startup, so a
  // board nobody opens from a phone never writes them.
  let vapid: VapidKeys | undefined;
  const vapidKeys = () => (vapid ??= loadVapidKeys(harness.config.dataDir));
  app.get('/push/key', (c) => c.json({ publicKey: vapidKeys().publicKey } satisfies PushKey));
  // The listener is never removed: the API lives as long as the harness.
  const notifier = new PushNotifier(harness.store, pushSender, vapidKeys);
  harness.subscribe((event) => {
    notifier.handle(event).catch((err: unknown) => console.error('harnessboard: push failed', err));
  });
  app.post('/push/subscribe', async (c) => {
    const device = remoteDevice(c, 'push');
    const subscription = parseSubscription(await c.req.json().catch(() => null));
    if (!subscription) throw new Error('send a push subscription with an https endpoint and keys');
    harness.store.setPushSubscription(device.id, subscription);
    return c.json({ ok: true }, 201);
  });
  app.delete('/push/subscribe', (c) => {
    harness.store.setPushSubscription(remoteDevice(c, 'push').id, null);
    return c.json({ ok: true });
  });

  app.get('/devices', (c) => c.json(harness.store.listDevices()));
  app.delete('/devices/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!harness.store.revokeDevice(id)) return c.json({ error: `device ${id} not found` }, 404);
    sessions.end(id);
    return c.json({ id });
  });

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

function taskId(c: Context<AccessEnv>): number {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid task id: ${c.req.param('id')}`);
  return id;
}

/** The remote device that made the request. Passkeys and push belong to remote devices only. */
function remoteDevice(c: Context<AccessEnv>, what: 'passkeys' | 'push' = 'passkeys') {
  const device = c.get('device');
  if (!device) throw new Error(`${what} are only used by devices paired from a phone`);
  return device;
}

/** The relying party is the remote host the phone opened, always over HTTPS (`tailscale serve`). */
function party(c: Context<AccessEnv>): Party {
  const host = (c.req.header('host') ?? '').toLowerCase();
  return { rpID: host.replace(/:\d+$/, ''), origin: `https://${host}` };
}

/** Starts a board session for the device that just passed a passkey step. */
function sessionReply(c: Context<AccessEnv>, sessions: Sessions, deviceId: number) {
  return c.json({ ok: true, session: sessions.open(deviceId) } satisfies PasskeySession);
}

/** WebAuthn options as they are, `{ok: true}` for a step without a value, or the refusal. */
function passkeyReply<T>(c: Context<AccessEnv>, result: PasskeyResult<T>) {
  if (!result.ok) {
    const [status, error] = PASSKEY_REFUSALS[result.reason];
    return c.json({ error }, status);
  }
  return c.json(result.value ?? { ok: true });
}
