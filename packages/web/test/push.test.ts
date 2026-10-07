// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setNotifications } from '../src/notify';
import { base64UrlToBytes, notifyMode, taskFromHash, taskFromMessage } from '../src/push';

describe('notifyMode', () => {
  it('notifies from the page on the computer at 127.0.0.1', () => {
    expect(notifyMode('127.0.0.1', true)).toBe('browser');
  });

  it('notifies from the page on the computer at localhost', () => {
    expect(notifyMode('localhost', true)).toBe('browser');
  });

  it('notifies from the page on the computer at [::1]', () => {
    expect(notifyMode('[::1]', true)).toBe('browser');
  });

  it('notifies from the page on the computer even where push is missing', () => {
    expect(notifyMode('127.0.0.1', false)).toBe('browser');
  });

  it('pushes to a board opened remotely', () => {
    expect(notifyMode('desk.tail1234.ts.net', true)).toBe('push');
  });

  it('cannot notify a board opened remotely in a browser without push', () => {
    expect(notifyMode('desk.tail1234.ts.net', false)).toBe('unsupported');
  });
});

describe('taskFromHash', () => {
  it('reads the task a tapped push opens', () => {
    expect(taskFromHash('#task=12')).toBe(12);
  });

  it('reads nothing from a hash without a task', () => {
    expect(taskFromHash('#pair=abc')).toBeNull();
  });

  it('reads nothing from a task that is not a number', () => {
    expect(taskFromHash('#task=abc')).toBeNull();
  });

  it('reads nothing from task 0', () => {
    expect(taskFromHash('#task=0')).toBeNull();
  });
});

describe('taskFromMessage', () => {
  it('reads the task the service worker asks the board to open', () => {
    expect(taskFromMessage({ type: 'open-task', taskId: 12 })).toBe(12);
  });

  it('reads nothing from another kind of message', () => {
    expect(taskFromMessage({ type: 'other', taskId: 12 })).toBeNull();
  });

  it('reads nothing from a message that is not an object', () => {
    expect(taskFromMessage('open-task')).toBeNull();
  });
});

describe('base64UrlToBytes', () => {
  it('decodes base64url, including its - and _ characters', () => {
    expect([...base64UrlToBytes('-_8')]).toEqual([251, 255]);
  });
});

/** The calls the board made, as `METHOD path`. */
let calls: string[] = [];
let subscribed: unknown = null;
const subscription = {
  toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }),
  unsubscribe: vi.fn(() => Promise.resolve(true)),
};
const registration = {
  pushManager: {
    getSubscription: vi.fn(() => Promise.resolve(null as typeof subscription | null)),
    subscribe: vi.fn((_options: { applicationServerKey: Uint8Array }) =>
      Promise.resolve(subscription),
    ),
  },
};
const serviceWorker = {
  register: vi.fn(() => Promise.resolve(registration)),
  ready: Promise.resolve(registration),
  getRegistration: vi.fn(() => Promise.resolve(registration)),
};

beforeEach(() => {
  calls = [];
  subscribed = null;
  vi.clearAllMocks();
  vi.stubGlobal('Notification', {
    permission: 'default',
    requestPermission: () => Promise.resolve('granted'),
  });
  vi.stubGlobal('navigator', { serviceWorker });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push(`${init.method ?? 'GET'} ${url}`);
    if (init.method === 'POST') subscribed = JSON.parse(init.body as string);
    if (url === '/api/push/key') return Promise.resolve(Response.json({ publicKey: 'AQID' }));
    return Promise.resolve(Response.json({ ok: true }));
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('setNotifications', () => {
  it('registers the service worker when switched on in a remote board', async () => {
    await setNotifications(true, 'push');
    expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js');
  });

  it('subscribes with the board key when switched on in a remote board', async () => {
    await setNotifications(true, 'push');
    const [options] = registration.pushManager.subscribe.mock.calls[0]!;
    expect([...options.applicationServerKey]).toEqual([1, 2, 3]);
  });

  it('hands the subscription to the board when switched on in a remote board', async () => {
    await setNotifications(true, 'push');
    expect([calls, subscribed]).toEqual([
      ['GET /api/push/key', 'POST /api/push/subscribe'],
      { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } },
    ]);
  });

  it('ends the subscription on the board when switched off in a remote board', async () => {
    await setNotifications(false, 'push');
    expect(calls).toEqual(['DELETE /api/push/subscribe']);
  });

  it('drops the browser subscription when switched off in a remote board', async () => {
    registration.pushManager.getSubscription.mockResolvedValueOnce(subscription);
    await setNotifications(false, 'push');
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe when the browser refuses notifications', async () => {
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: () => Promise.resolve('denied'),
    });
    await setNotifications(true, 'push');
    expect(calls).toEqual(['DELETE /api/push/subscribe']);
  });

  it('fails when the board refuses the subscription', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        url === '/api/push/key'
          ? Response.json({ publicKey: 'AQID' })
          : Response.json({ error: 'nope' }, { status: 400 }),
      ),
    );
    await expect(setNotifications(true, 'push')).rejects.toThrow('nope');
  });

  it('calls nothing on the board when switched on at the computer', async () => {
    await setNotifications(true, 'browser');
    expect([calls, serviceWorker.register.mock.calls.length]).toEqual([[], 0]);
  });

  it('calls nothing on the board when switched off at the computer', async () => {
    await setNotifications(false, 'browser');
    expect(calls).toEqual([]);
  });

  it('returns the permission the browser gave', async () => {
    expect(await setNotifications(true, 'browser')).toBe('granted');
  });
});
