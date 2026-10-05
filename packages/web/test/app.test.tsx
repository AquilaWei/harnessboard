// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskView } from '@harnessboard/shared';
import { App } from '../src/App';
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
const server = (url: string) => {
  // Pairing and creating the passkey, as a phone that opened the pairing address does them.
  if (url === '/api/pair') return Response.json({ id: 1, name: 'Pixel 9' }, { status: 201 });
  if (url === '/api/passkey/options') return Response.json({ challenge: 'c' });
  if (url === '/api/passkey') {
    revoked = false;
    return Response.json({ ok: true, session: 's' });
  }
  if (revoked) return new Response('{"error":"this device is not paired"}', { status: 401 });
  if (locked)
    return new Response('{"error":"this device is locked","locked":true}', { status: 401 });
  if (reauth && url === '/api/tasks/1/queue')
    return new Response('{"error":"confirm with your passkey first","reauth":true}', {
      status: 401,
    });
  if (url === '/api/tasks') return Response.json([task]);
  if (url === '/api/version') return Response.json({ version: '0.0.0' });
  return Response.json(null);
};

class NoEvents {
  addEventListener() {}
  close() {}
}

let root: Root;
let container: HTMLElement;

beforeEach(async () => {
  revoked = false;
  locked = false;
  reauth = false;
  vi.stubGlobal('fetch', (url: string) => Promise.resolve(server(url)));
  vi.stubGlobal('EventSource', NoEvents);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
});

afterEach(() => {
  act(() => root.unmount());
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
});
