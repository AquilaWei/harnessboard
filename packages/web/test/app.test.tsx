// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskView } from '@harnessboard/shared';
import { App } from '../src/App';
import { notificationsEnabled, setNotifications } from '../src/notify';
import '../src/i18n';

// The phone's passkey prompt; each test says whether it passes.
const webauthn = vi.hoisted(() => ({ startRegistration: vi.fn(), startAuthentication: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => webauthn);

// Lets React flush effects and state updates inside `act`.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = {
  id: 1,
  title: 'Write the docs',
  status: 'backlog',
  mode: 'single',
  agents: { implementer: 'claude', reviewer: null, maxReviewRounds: 2 },
  activity: null,
  context: null,
  loop: null,
  lastReview: null,
  reviewPending: false,
  lastNotice: null,
  plan: null,
  criteria: null,
  permissionRequests: [],
  resumeAt: null,
  verifyCommand: null,
} as unknown as TaskView;

/** The server: answers the board's calls until the device is revoked or locked, then only 401. */
let revoked = false;
let locked = false;
/** Actions answer 401 `{reauth: true}`, as they do on a phone without a recent passkey check. */
let reauth = false;
/** The title `/api/tasks` answers with, changed by a test to see the board reload. */
let title = 'Write the docs';
/** The status `/api/tasks` answers with. */
let status = 'backlog';
const server = (url: string) => {
  // Pairing and creating the passkey, as a phone that opened the pairing address does them.
  if (url === '/api/pair') return Response.json({ id: 1, name: 'Pixel 9' }, { status: 201 });
  if (url === '/api/passkey/options') return Response.json({ challenge: 'c' });
  if (url === '/api/passkey') {
    revoked = false;
    return Response.json({ ok: true, session: 's' });
  }
  // The passkey check that unlocks a locked phone.
  if (url === '/api/auth/challenge') return Response.json({ challenge: 'c' });
  if (url === '/api/auth/verify') {
    locked = false;
    return Response.json({ ok: true, session: 's2' });
  }
  if (revoked) return new Response('{"error":"this device is not paired"}', { status: 401 });
  if (locked)
    return new Response('{"error":"this device is locked","locked":true}', { status: 401 });
  if (reauth && url === '/api/tasks/1/queue')
    return new Response('{"error":"confirm with your passkey first","reauth":true}', {
      status: 401,
    });
  if (url === '/api/tasks') return Response.json([{ ...task, title, status }]);
  // The task panel's event and timeline lists, empty; its other reads stay null (loading).
  if (/^\/api\/tasks\/1\/(events|timeline)\b/.test(url)) return Response.json([]);
  if (url === '/api/version') return Response.json({ version: '0.0.0' });
  return Response.json(null);
};

/** The event streams the board opened, newest last. */
let streams: FakeEvents[] = [];
class FakeEvents {
  readonly url: string;
  readyState = 1;
  readonly listeners = new Map<string, (e: MessageEvent<string>) => void>();
  constructor(url: string) {
    this.url = url;
    streams.push(this);
  }
  addEventListener(type: string, listener: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.readyState = 2;
  }
  /** The stream drops; `readyState` 2 says it gave up (an HTTP error), 0 that it retries. */
  fail(readyState: number) {
    this.readyState = readyState;
    this.listeners.get('error')!(new MessageEvent('error'));
  }
  emit(type: string, data: string) {
    this.listeners.get(type)!(new MessageEvent(type, { data }));
  }
}

/** Calls to these paths wait for {@link release}, answering as the server would have when sent. */
let holding: string[] = [];
let held: (() => void)[] = [];
const release = async () => {
  await act(async () => {
    for (const answer of held) answer();
    held = [];
  });
};

let root: Root;
let container: HTMLElement;

beforeEach(async () => {
  revoked = false;
  locked = false;
  reauth = false;
  title = 'Write the docs';
  status = 'backlog';
  streams = [];
  holding = [];
  held = [];
  vi.stubGlobal('fetch', (url: string) => {
    const res = server(url);
    if (!holding.includes(url)) return Promise.resolve(res);
    return new Promise<Response>((resolve) => held.push(() => resolve(res)));
  });
  vi.stubGlobal('EventSource', FakeEvents);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

/** Types into a React-controlled input. */
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

/** Opens the board again, e.g. at a pairing address set just before. */
const reopen = async () => {
  act(() => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(<App />));
};

const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === text)!;

describe('App', () => {
  it('shows the board while the device is paired', () => {
    expect(container.textContent).toContain('Write the docs');
  });

  it('swaps the board for the not-paired screen when an action after revocation gets 401', async () => {
    revoked = true;
    await act(async () => button('Start').click());
    expect(container.querySelector('[role="alert"] h2')?.textContent).toBe(
      'This device is not paired',
    );
    expect(container.textContent).not.toContain('Write the docs');
  });

  it('swaps the board for the not-paired screen when opening a task after revocation gets 401', async () => {
    revoked = true;
    await act(async () => container.querySelector<HTMLButtonElement>('.card-open')!.click());
    expect(container.querySelector('[role="alert"] h2')?.textContent).toBe(
      'This device is not paired',
    );
    expect(container.textContent).not.toContain('Write the docs');
  });

  it('swaps the board for the unlock screen when a call gets 401 locked', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    locked = true;
    await act(async () => button('Start').click());
    expect([container.querySelector('h2')?.textContent, button('Unlock') !== undefined]).toEqual([
      'The board is locked',
      true,
    ]);
  });

  it('tells a browser without passkeys to open the page in Chrome or Safari instead of unlocking', async () => {
    locked = true;
    await act(async () => button('Start').click());
    expect([container.textContent?.includes('Chrome or Safari'), button('Unlock')]).toEqual([
      true,
      undefined,
    ]);
  });

  it('tells a browser without passkeys to open the pairing page in Chrome or Safari', async () => {
    history.replaceState(null, '', '/#pair=abc');
    await reopen();
    expect([container.textContent?.includes('Chrome or Safari'), button('Pair')]).toEqual([
      true,
      undefined,
    ]);
  });

  it('keeps the pairing code in the address of a browser without passkeys', async () => {
    history.replaceState(null, '', '/#pair=abc');
    await reopen();
    expect(window.location.hash).toBe('#pair=abc');
  });

  it('shows the pairing form in a browser with passkeys', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    history.replaceState(null, '', '/#pair=abc');
    await reopen();
    expect(button('Pair')).toBeDefined();
  });

  it('shows the board after pairing once the passkey is created', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    webauthn.startRegistration.mockResolvedValueOnce({ id: 'cred' });
    revoked = true;
    history.replaceState(null, '', '/#pair=abc');
    await reopen();
    act(() => type(container.querySelector('input')!, 'Pixel 9'));
    await act(async () => button('Pair').click());
    expect(container.textContent).toContain('Write the docs');
  });

  it('stays on the pairing screen, offering the passkey again, when creating it fails', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    webauthn.startRegistration.mockRejectedValueOnce(new Error('The operation was cancelled'));
    revoked = true;
    history.replaceState(null, '', '/#pair=abc');
    await reopen();
    act(() => type(container.querySelector('input')!, 'Pixel 9'));
    await act(async () => button('Pair').click());
    expect([container.textContent?.includes('Write the docs'), button('Create passkey')]).toEqual([
      false,
      expect.anything(),
    ]);
  });

  it('keeps the board and says why when the passkey prompt for an action is cancelled', async () => {
    webauthn.startAuthentication.mockRejectedValueOnce(new Error('The operation was cancelled'));
    reauth = true;
    await act(async () => button('Start').click());
    expect([
      container.querySelector('[role="status"]')?.textContent,
      container.textContent?.includes('Write the docs'),
    ]).toEqual(['Not done: a phone must confirm this with its passkey.', true]);
  });
  it('shows the board after pairing when a board read sent before pairing gets its 401 late', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    webauthn.startRegistration.mockResolvedValueOnce({ id: 'cred' });
    revoked = true;
    holding = ['/api/tasks', '/api/status', '/api/settings', '/api/version'];
    history.replaceState(null, '', '/#pair=abc');
    await reopen();
    holding = [];
    act(() => type(container.querySelector('input')!, 'Pixel 9'));
    await act(async () => button('Pair').click());
    await release();
    expect(container.textContent).toContain('Write the docs');
  });

  it('shows the board after unlocking when a board read sent before unlocking gets its 401 late', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    webauthn.startAuthentication.mockResolvedValueOnce({ id: 'cred' });
    locked = true;
    holding = ['/api/settings'];
    await reopen();
    holding = [];
    await act(async () => button('Unlock').click());
    await release();
    expect(container.textContent).toContain('Write the docs');
  });

  it('shows the unlock screen when the event stream is refused after a server restart', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    locked = true; // the restart dropped the board session
    await act(async () => streams.at(-1)!.fail(2));
    expect([container.querySelector('h2')?.textContent, button('Unlock') !== undefined]).toEqual([
      'The board is locked',
      true,
    ]);
  });

  it('reopens the event stream with the new session after unlocking from a restart', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    webauthn.startAuthentication.mockResolvedValueOnce({ id: 'cred' });
    locked = true;
    await act(async () => streams.at(-1)!.fail(2));
    await act(async () => button('Unlock').click());
    expect(streams.at(-1)!.url).toBe('/api/events?session=s2');
  });

  it('reloads the board on an event after unlocking from a restart', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    webauthn.startAuthentication.mockResolvedValueOnce({ id: 'cred' });
    locked = true;
    await act(async () => streams.at(-1)!.fail(2));
    await act(async () => button('Unlock').click());
    vi.useFakeTimers();
    title = 'Write the README';
    act(() => streams.at(-1)!.emit('task', '{"type":"task","taskId":1}'));
    await act(async () => vi.advanceTimersByTime(500));
    expect(container.textContent).toContain('Write the README');
  });

  it('keeps the board while the event stream retries after a network failure', async () => {
    locked = true;
    await act(async () => streams.at(-1)!.fail(0));
    expect(container.textContent).toContain('Write the docs');
  });

  it('reopens the event stream later when it is refused but the server lets the board in', async () => {
    vi.useFakeTimers();
    await act(async () => streams.at(-1)!.fail(2));
    await act(async () => vi.advanceTimersByTime(3000));
    expect(streams.length).toBe(2);
  });

  it('opens a task tapped in a push on the tab for its status', async () => {
    status = 'review';
    history.replaceState(null, '', '/#task=1');
    await reopen();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Changes',
    );
  });

  it('clears a tapped push from the address once the board reads it', async () => {
    history.replaceState(null, '', '/#task=1');
    await reopen();
    expect(location.hash).toBe('');
  });

  it('opens a task tapped in a push once a locked phone is unlocked', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    webauthn.startAuthentication.mockResolvedValueOnce({ id: 'cred' });
    locked = true;
    status = 'review';
    history.replaceState(null, '', '/#task=1');
    await reopen();
    await act(async () => button('Unlock').click());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Changes',
    );
  });

  it('opens a task when the service worker asks the open board to', async () => {
    const worker = new EventTarget();
    Object.defineProperty(navigator, 'serviceWorker', { value: worker, configurable: true });
    await reopen();
    status = 'review';
    await act(async () => {
      worker.dispatchEvent(new MessageEvent('message', { data: { type: 'open-task', taskId: 1 } }));
    });
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Changes',
    );
  });
});

describe('notifications after pairing again', () => {
  /** The push calls the board got, as `METHOD path`. */
  let pushCalls: string[] = [];
  const subscription = {
    toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } }),
  };
  const registration = { pushManager: { getSubscription: () => Promise.resolve(subscription) } };

  beforeEach(() => {
    pushCalls = [];
    localStorage.removeItem('harnessboard.notify');
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
    vi.stubGlobal('Notification', {
      permission: 'granted',
      requestPermission: () => Promise.resolve('granted'),
    });
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/push/')) pushCalls.push(`${init?.method ?? 'GET'} ${url}`);
      return Promise.resolve(server(url));
    });
    // The browser keeps its push subscription when the board revokes the device.
    const worker = Object.assign(new EventTarget(), {
      register: () => Promise.resolve(registration),
      ready: Promise.resolve(registration),
    });
    Object.defineProperty(navigator, 'serviceWorker', { value: worker, configurable: true });
  });

  afterEach(() => {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    localStorage.removeItem('harnessboard.notify');
  });

  /** Switches push on, has the board revoke the device, then pairs this browser again. */
  const enableRevokeAndPairAgain = async () => {
    await setNotifications(true, 'push');
    revoked = true;
    webauthn.startRegistration.mockResolvedValueOnce({ id: 'cred' });
    history.replaceState(null, '', '/#pair=abc');
    await reopen();
    act(() => type(container.querySelector('input')!, 'Pixel 9'));
    await act(async () => button('Pair').click());
  };

  it('shows notifications switched off once the browser is paired again', async () => {
    await enableRevokeAndPairAgain();
    expect(notificationsEnabled()).toBe(false);
  });

  it('hands the kept subscription to the board when switched on again after pairing', async () => {
    await enableRevokeAndPairAgain();
    pushCalls = [];
    await setNotifications(true, 'push');
    expect([pushCalls, notificationsEnabled()]).toEqual([['POST /api/push/subscribe'], true]);
  });
});
