// SPDX-License-Identifier: Apache-2.0
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const publicDir = new URL('../public/', import.meta.url);
const source = (file: string) => readFileSync(new URL(file, publicDir), 'utf8');

interface PushNotice {
  taskUrl: (taskId: number) => string;
  pushNotice: (
    payload: { taskId: number; title: string; status: string },
    language: string,
  ) => { title: string; options: NotificationOptions };
}

/** Runs public/push-notice.js as `importScripts` does: a classic script on a global `self`. */
function loadPushNotice(): PushNotice {
  const scope = { self: {} as { harnessboardPush?: PushNotice } };
  runInContext(source('push-notice.js'), createContext(scope));
  return scope.self.harnessboardPush!;
}

type Listener = (event: object) => void;

/** A service worker global for public/sw.js, recording what it shows and opens. */
function loadServiceWorker(boards: { postMessage: unknown; focus: unknown }[]) {
  const listeners = new Map<string, Listener>();
  const registration = { showNotification: vi.fn(() => Promise.resolve()) };
  const clients = {
    matchAll: vi.fn(() => Promise.resolve(boards)),
    openWindow: vi.fn(() => Promise.resolve(null)),
  };
  const scope: Record<string, unknown> = {
    navigator: { language: 'en-US' },
    registration,
    clients,
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    importScripts: (url: string) => runInContext(source(url.slice(1)), context),
  };
  scope.self = scope;
  const context = createContext(scope);
  runInContext(source('sw.js'), context);
  /** Fires an event and waits for what it passed to `waitUntil`. */
  const fire = async (type: string, event: object) => {
    let pending: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  };
  return { registration, clients, fire };
}

const payload = { taskId: 12, title: 'Fix login', status: 'review' };

describe('push-notice.js', () => {
  it('builds the board address that opens a task', () => {
    expect(loadPushNotice().taskUrl(12)).toBe('/#task=12');
  });

  it('titles a push with the task number and title', () => {
    expect(loadPushNotice().pushNotice(payload, 'en-US').title).toBe('#12 Fix login');
  });

  it('shows the status in English on an English phone', () => {
    expect(loadPushNotice().pushNotice(payload, 'en-US').options.body).toBe('Ready for review');
  });

  it('shows the status in Chinese on a Chinese phone', () => {
    expect(loadPushNotice().pushNotice(payload, 'zh-TW').options.body).toBe('待審核');
  });

  it('tags a push by task, as the board tags its own notifications', () => {
    expect(loadPushNotice().pushNotice(payload, 'en-US').options.tag).toBe('task-12');
  });

  it('keeps the task id for the tap', () => {
    expect(loadPushNotice().pushNotice(payload, 'en-US').options.data).toEqual({ taskId: 12 });
  });
});

describe('sw.js', () => {
  it('shows a push as a notification with the task and its status', async () => {
    const { registration, fire } = loadServiceWorker([]);
    await fire('push', { data: { json: () => payload } });
    expect(registration.showNotification.mock.calls[0]).toMatchObject([
      '#12 Fix login',
      { body: 'Ready for review', tag: 'task-12', data: { taskId: 12 } },
    ]);
  });

  it('opens a board on the task when a push is tapped and no board is open', async () => {
    const { clients, fire } = loadServiceWorker([]);
    await fire('notificationclick', { notification: { data: { taskId: 12 }, close: () => {} } });
    expect(clients.openWindow).toHaveBeenCalledWith('/#task=12');
  });

  it('asks an open board to open the task instead of reloading it', async () => {
    const board = { postMessage: vi.fn(), focus: vi.fn(() => Promise.resolve()) };
    const { clients, fire } = loadServiceWorker([board]);
    await fire('notificationclick', { notification: { data: { taskId: 12 }, close: () => {} } });
    expect([board.postMessage.mock.calls[0], clients.openWindow.mock.calls.length]).toEqual([
      [{ type: 'open-task', taskId: 12 }],
      0,
    ]);
  });

  it('brings an open board to the front when a push is tapped', async () => {
    const board = { postMessage: vi.fn(), focus: vi.fn(() => Promise.resolve()) };
    const { fire } = loadServiceWorker([board]);
    await fire('notificationclick', { notification: { data: { taskId: 12 }, close: () => {} } });
    expect(board.focus).toHaveBeenCalledTimes(1);
  });
});
