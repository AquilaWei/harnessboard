// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskView } from '@harnessboard/shared';
import { App } from '../src/App';
import '../src/i18n';

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

/** The server: answers the board's calls until the device is revoked, then only 401. */
let revoked = false;
const server = (url: string) => {
  if (revoked) return new Response('{"error":"this device is not paired"}', { status: 401 });
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
});

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
});
