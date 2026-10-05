// SPDX-License-Identifier: Apache-2.0
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import type { Store } from '@harnessboard/core';
import { NOTIFY_STATUSES } from '@harnessboard/shared';
import type {
  HarnessEvent,
  PushPayload,
  PushSubscriptionInfo,
  TaskStatus,
} from '@harnessboard/shared';

/** File in the data folder (`HARNESSBOARD_HOME` when set) that holds the board's VAPID keys. */
export const VAPID_FILE = 'vapid.json';

/** Longest push endpoint accepted; real ones are a few hundred characters. */
const MAX_ENDPOINT = 2048;

/** Longest `p256dh` or `auth` value accepted; real ones are under 100 characters. */
const MAX_KEY = 256;

/**
 * The board's VAPID key pair, base64url, in the form `web-push` takes: the public key is the
 * uncompressed P-256 point, the private key the 32-byte scalar.
 */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * The VAPID keys in `dir`, made on first use and read back afterwards, so subscriptions keep
 * working across restarts. On macOS and Linux the file is readable by its owner only, since the
 * private key lets anyone push to the paired phones; Windows ignores the file mode, so there the
 * file keeps the permissions it inherits from `dir`. Throws when the file exists but is not valid JSON; deleting
 * it makes new keys, and every phone then has to turn notifications on again.
 */
export function loadVapidKeys(dir: string): VapidKeys {
  const file = path.join(dir, VAPID_FILE);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as VapidKeys;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const keys = newVapidKeys();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  return keys;
}

function newVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  // A JWK holds each coordinate and the scalar at full length, so no padding is needed.
  const jwk = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url'),
  ]);
  return { publicKey: point.toString('base64url'), privateKey: jwk.d! };
}

/**
 * The subscription in a `POST /api/push/subscribe` body, or null when it is not one. The board
 * will post to the endpoint, so it must be an https URL.
 */
export function parseSubscription(body: unknown): PushSubscriptionInfo | null {
  const { endpoint, keys } = (body ?? {}) as { endpoint?: unknown; keys?: unknown };
  const { p256dh, auth } = (keys ?? {}) as { p256dh?: unknown; auth?: unknown };
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT) return null;
  if (!isKey(p256dh) || !isKey(auth)) return null;
  if (!URL.canParse(endpoint) || new URL(endpoint).protocol !== 'https:') return null;
  return { endpoint, keys: { p256dh, auth } };
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY;
}

/**
 * Who VAPID says is sending. Push services may use it to reach the sender about a problem; Apple's
 * rejects a push without one.
 */
const VAPID_SUBJECT = 'https://github.com/AquilaWei/harnessboard';

/** `gone`: the push service no longer knows the subscription (404 or 410), so drop it. */
export type PushOutcome = 'sent' | 'gone';

/** Delivers one push; `web-push` in production, a fake in tests. */
export interface PushSender {
  /** Rejects when the push service fails in any other way than reporting the subscription gone. */
  send(subscription: PushSubscriptionInfo, payload: string, keys: VapidKeys): Promise<PushOutcome>;
}

export const webPushSender: PushSender = {
  async send(subscription, payload, keys) {
    try {
      await webpush.sendNotification(subscription, payload, {
        vapidDetails: { subject: VAPID_SUBJECT, ...keys },
      });
      return 'sent';
    } catch (err) {
      if (isGone(err)) return 'gone';
      throw err;
    }
  },
};

/** Whether a `web-push` error means the push service has dropped the subscription. */
export function isGone(err: unknown): boolean {
  return err instanceof webpush.WebPushError && [404, 410].includes(err.statusCode);
}

/**
 * Pushes to every subscribed phone when a task enters a status in `NOTIFY_STATUSES`. A task is
 * pushed once per entry: a repeated event for the status it already has sends nothing, and tasks
 * already waiting when the board starts are not pushed again.
 */
export class PushNotifier {
  /** Last status seen per task, so only a change into a notify status pushes. */
  private readonly statuses = new Map<number, string>();

  /** `keys` is only called when there is a phone to push to. */
  constructor(
    private readonly store: Store,
    private readonly sender: PushSender,
    private readonly keys: () => VapidKeys,
  ) {
    for (const task of store.listTasks()) this.statuses.set(task.id, task.status);
  }

  /**
   * Sends the pushes `event` calls for. Every phone is tried; rejects with an `AggregateError`
   * of the sends that failed. A phone whose subscription is gone has it removed.
   */
  async handle(event: HarnessEvent): Promise<void> {
    if (event.type === 'deleted') this.statuses.delete(event.taskId);
    if (event.type !== 'task') return;
    const previous = this.statuses.get(event.taskId);
    this.statuses.set(event.taskId, event.status);
    if (event.status === previous || !isNotifyStatus(event.status)) return;
    const task = this.store.getTask(event.taskId);
    const targets = this.store.listPushSubscriptions();
    if (!task || targets.length === 0) return;
    const payload: PushPayload = { taskId: task.id, title: task.title, status: event.status };
    const json = JSON.stringify(payload);
    const keys = this.keys();
    const results = await Promise.allSettled(
      targets.map(async ({ deviceId, subscription }) => {
        if ((await this.sender.send(subscription, json, keys)) === 'gone') {
          this.dropSubscription(deviceId, subscription.endpoint);
        }
      }),
    );
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    if (failures.length > 0) throw new AggregateError(failures, 'push failed');
  }

  /** Removes the subscription unless the phone subscribed again while the push was in flight. */
  private dropSubscription(deviceId: number, endpoint: string): void {
    const current = this.store.listPushSubscriptions().find((p) => p.deviceId === deviceId);
    if (current?.subscription.endpoint === endpoint) this.store.setPushSubscription(deviceId, null);
  }
}

function isNotifyStatus(status: string): status is TaskStatus {
  return NOTIFY_STATUSES.has(status as TaskStatus);
}
