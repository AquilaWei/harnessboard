// SPDX-License-Identifier: Apache-2.0
import { api } from './api';

/**
 * How this board notifies you that a task needs you:
 * - `browser`: on the computer itself (a loopback address), a notification from the open page,
 *   as before phone access existed;
 * - `push`: opened remotely, i.e. from a paired phone, through Web Push, which also arrives
 *   while the board is closed;
 * - `unsupported`: opened remotely in a browser without Web Push, such as Safari on an iPhone
 *   before the board is added to the Home Screen, or any page served without HTTPS.
 */
export type NotifyMode = 'browser' | 'push' | 'unsupported';

// The names the server's host check treats as the computer itself (server/src/access.ts).
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Picks the {@link NotifyMode} for a board at `hostname` (as in `location.hostname`). */
export function notifyMode(hostname: string, pushSupported: boolean): NotifyMode {
  if (LOOPBACK_NAMES.has(hostname.toLowerCase())) return 'browser';
  return pushSupported ? 'push' : 'unsupported';
}

/** The {@link NotifyMode} of this page. */
export function currentNotifyMode(): NotifyMode {
  const pushSupported =
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof PushManager !== 'undefined';
  return notifyMode(location.hostname, pushSupported);
}

/** The task id in a `#task=<id>` hash, which a tapped push opens (public/push-notice.js). */
export function taskFromHash(hash: string): number | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get('task');
  const id = Number(value);
  return value && Number.isInteger(id) && id > 0 ? id : null;
}

/** The task id in a message from public/sw.js asking an open board to open a task. */
export function taskFromMessage(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const { type, taskId } = data as { type?: unknown; taskId?: unknown };
  return type === 'open-task' && Number.isInteger(taskId) && (taskId as number) > 0
    ? (taskId as number)
    : null;
}

/** Decodes the base64url VAPID key into the bytes `PushManager.subscribe` takes everywhere. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * Registers the service worker, subscribes this browser to push and hands the subscription to
 * the board for this device. Fails when the browser refuses the subscription or the board the
 * request; the caller must already hold notification permission.
 */
export async function enablePush(): Promise<void> {
  await navigator.serviceWorker.register('/sw.js');
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes((await api.pushKey()).publicKey),
    }));
  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) throw new Error('the browser gave no push keys');
  await api.subscribePush({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
}

/**
 * Stops pushes to this device: first on the board, so nothing is sent even if the browser then
 * fails to drop its subscription.
 */
export async function disablePush(): Promise<void> {
  await api.unsubscribePush();
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
}
