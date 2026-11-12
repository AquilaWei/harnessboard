// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HarnessStatus, LocalAiStatus } from '@harnessboard/shared';
import { Header } from '../src/components/Header';
import { api } from '../src/api';
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
  vi.spyOn(api, 'localAiModels').mockResolvedValue({ models: ['lfm2.5'] });
  await i18n.changeLanguage('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
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
  expect(button().textContent).toBe('Local AI: lfm2.5 · ' + label);
});
it('shows the active use case, model and queued count', () => {
  render({
    ...idle,
    state: 'running',
    running: { useCase: 'slug', model: 'mellum2.1', startedAt: 0 },
    queued: 2,
  });
  expect(button().textContent).toBe(
    'Local AI: mellum2.1 · Running · Naming a branch · mellum2.1 · Queued: 2',
  );
});
it('lists models and the resolved command', () => {
  render(idle);
  act(() => button().click());
  const panel = container.querySelector('[role="dialog"]')!;
  expect(panel.textContent).toContain('Naming a branchmellum2.1');
  expect(panel.textContent).toContain('Drafting a commit messageqwen');
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
  expect(container.querySelector('[role="dialog"]')!.textContent).toContain(
    'Naming a branch: Timed out',
  );
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
  expect(button().textContent).toBe('本地 AI: lfm2.5 · 閒置 · 排隊：1');
});

it.each([
  ['loading', 'Loading'],
  ['unloaded', 'Not loaded'],
  ['error', 'Error'],
] as const)('renders the model lifecycle state %s', (state, label) => {
  render({ ...idle, state, selectedModel: 'chosen', loadedModel: 'actual' });
  expect(button().textContent).toContain(`chosen · ${label}`);
});
it('selects a registered model without replacing the loaded model display', async () => {
  const select = vi.spyOn(api, 'selectLocalAiModel').mockResolvedValue({});
  render({ ...idle, selectedModel: null, loadedModel: 'old' });
  await act(async () => button().click());
  const dropdown = container.querySelector<HTMLSelectElement>('select')!;
  await act(async () => {
    dropdown.value = 'lfm2.5';
    dropdown.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(select).toHaveBeenCalledWith('lfm2.5');
  expect(container.textContent).toContain('Loaded model: old');
});
it('retains conversation across panel closes and sends follow-up history', async () => {
  const chat = vi.spyOn(api, 'localAiChat').mockResolvedValue({
    status: 'ok',
    answer: 'Create a task',
    snapshotAt: '2026-11-11T00:00:00Z',
    taskIds: [7],
  });
  render(idle);
  await act(async () => button().click());
  const ask = async (question: string) => {
    await act(async () => {
      const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        question,
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
  };
  await ask('How do I start?');
  expect(container.textContent).toContain('Create a task');
  act(() => button().click());
  await act(async () => button().click());
  expect(container.textContent).toContain('#7');
  await ask('Then what?');
  expect(chat).toHaveBeenLastCalledWith('Then what?', [
    { role: 'user', content: 'How do I start?' },
    { role: 'assistant', content: 'Create a task\nSnapshot: 2026-11-11T00:00:00Z · #7' },
  ]);
});
it('shows a Chinese recovery hint when answering fails', async () => {
  vi.spyOn(api, 'localAiChat').mockResolvedValue({
    status: 'failed',
    reason: 'timed out',
    snapshotAt: '',
    taskIds: [],
  });
  await i18n.changeLanguage('zh-TW');
  render(idle);
  await act(async () => button().click());
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      '目前進度？',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('重送問題');
  expect(container.querySelector('textarea')!.value).toBe('目前進度？');
});

async function sendQuestion(text: string) {
  await act(async () => {
    const input = container.querySelector<HTMLTextAreaElement>('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}
const action = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)!;
const reply = {
  status: 'ok',
  answer: '## Steps\n\n- **Create** a task\n\n```sh\necho hello\n```',
  snapshotAt: '2026-11-11T00:00:00Z',
  taskIds: [],
};

it('renders assistant markdown headings, lists and fenced code', async () => {
  vi.spyOn(api, 'localAiChat').mockResolvedValue(reply);
  render(idle);
  await act(async () => button().click());
  await sendQuestion('Help');
  expect(container.querySelector('.markdown h2')!.textContent).toBe('Steps');
  expect(container.querySelector('.markdown li strong')!.textContent).toBe('Create');
  expect(container.querySelector('.markdown pre code')!.textContent).toBe('echo hello\n');
});
it('clears visible conversation and sends no old context', async () => {
  const chat = vi.spyOn(api, 'localAiChat').mockResolvedValue(reply);
  render(idle);
  await act(async () => button().click());
  await sendQuestion('Help');
  act(() => action('Clear context').click());
  expect(container.querySelector('.local-ai-conversation')!.textContent).toBe('');
  await sendQuestion('Fresh');
  expect(chat).toHaveBeenLastCalledWith('Fresh', []);
});
it('replaces context with a summary for subsequent questions', async () => {
  const chat = vi
    .spyOn(api, 'localAiChat')
    .mockResolvedValueOnce(reply)
    .mockResolvedValueOnce({ ...reply, answer: 'Summary: create a task' })
    .mockResolvedValue(reply);
  render(idle);
  await act(async () => button().click());
  await sendQuestion('Help');
  await act(async () => action('Compact context').click());
  expect(chat).toHaveBeenLastCalledWith('', expect.any(Array), 'compact');
  expect(container.querySelector('.local-ai-conversation')!.textContent).toContain(
    'Summary: create a task',
  );
  expect(container.querySelector('.markdown h2')).toBeNull();
  await sendQuestion('Next?');
  expect(chat).toHaveBeenLastCalledWith('Next?', [
    { role: 'assistant', content: 'Summary: create a task' },
  ]);
});
it('preserves context when compaction fails', async () => {
  const chat = vi
    .spyOn(api, 'localAiChat')
    .mockResolvedValueOnce(reply)
    .mockRejectedValueOnce(new Error('timed out'))
    .mockResolvedValue(reply);
  render(idle);
  await act(async () => button().click());
  await sendQuestion('Help');
  await act(async () => action('Compact context').click());
  expect(container.querySelector('.markdown h2')!.textContent).toBe('Steps');
  await sendQuestion('Retry question');
  expect(chat.mock.calls[2]![1][0]).toEqual({ role: 'user', content: 'Help' });
});
