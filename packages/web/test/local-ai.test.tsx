// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { HarnessStatus, LocalAiStatus } from '@harnessboard/shared';
import { Header } from '../src/components/Header';
import i18n from '../src/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const idle: LocalAiStatus = {
  state: 'idle',
  command: '/usr/bin/localai',
  models: { slug: 'mellum2.1', commit: 'qwen' },
  running: null,
  queued: 0,
  lastError: null,
};
let root: Root;
let container: HTMLElement;
beforeEach(async () => {
  await i18n.changeLanguage('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function render(localAi: LocalAiStatus) {
  const status: HarnessStatus = {
    localAi,
    running: [],
    quotas: {},
    quotaPaused: [],
    maxConcurrent: 1,
    configFile: null,
  };
  act(() =>
    root.render(
      <Header
        status={status}
        running={0}
        attention={0}
        settings={null}
        version={null}
        onNewTask={() => {}}
        onSettings={() => {}}
        onAttention={() => {}}
      />,
    ),
  );
}
const button = () => container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
it.each([
  ['disabled', 'Disabled'],
  ['missing', 'Binary missing'],
  ['idle', 'Idle'],
  ['running', 'Running'],
] as const)('renders the %s state', (state, label) => {
  render({ ...idle, state });
  expect(button().textContent).toBe('Local AI: ' + label);
});
it('shows the active use case, model and queued count', () => {
  render({
    ...idle,
    state: 'running',
    running: { useCase: 'slug', model: 'mellum2.1', startedAt: 0 },
    queued: 2,
  });
  expect(button().textContent).toBe('Local AI: Running · slug · mellum2.1 · Queued: 2');
});
it('lists models and the resolved command', () => {
  render(idle);
  act(() => button().click());
  const panel = container.querySelector('[role="dialog"]')!;
  expect(panel.textContent).toContain('slugmellum2.1');
  expect(panel.textContent).toContain('commitqwen');
  expect(panel.textContent).toContain('/usr/bin/localai');
  expect(button().getAttribute('aria-expanded')).toBe('true');
});
it('shows not found for an unresolved command', () => {
  render({ ...idle, state: 'missing', command: null });
  act(() => button().click());
  expect(container.querySelector('[role="dialog"]')!.textContent).toContain('Command: not found');
});
it('shows the latest error use case, message and relative time', () => {
  render({
    ...idle,
    lastError: { useCase: 'slug', message: 'Timed out', at: Date.now() - 120_000 },
  });
  act(() => button().click());
  expect(container.querySelector('[role="dialog"]')!.textContent).toContain('slug: Timed out');
  expect(container.querySelector('time')!.textContent).toBe('2 minutes ago');
});
it('closes with Escape and outside clicks', () => {
  render(idle);
  act(() => button().click());
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  act(() => button().click());
  act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
it('renders Traditional Chinese labels', async () => {
  await i18n.changeLanguage('zh-TW');
  render({ ...idle, queued: 1 });
  expect(button().textContent).toBe('本地 AI: 閒置 · 排隊：1');
});
