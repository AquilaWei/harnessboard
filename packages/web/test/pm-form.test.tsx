// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Settings } from '@harnessboard/shared';
import { NewTaskDialog } from '../src/components/NewTaskDialog';
import '../src/i18n';

const api = vi.hoisted(() => ({
  agents: vi.fn(),
  agentModels: vi.fn(),
  createTask: vi.fn(),
  inspectFolder: vi.fn(),
}));
vi.mock('../src/api', () => ({ api }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLElement;
let root: Root;
const settings = { defaultContextPolicy: { size: 'medium' } } as Settings;
const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
};
beforeEach(async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  api.agents.mockResolvedValue([
    { id: 'claude', profile: { provider: 'claude-code' }, ok: true },
    { id: 'codex', profile: { provider: 'codex' }, ok: true },
    { id: 'gemini', profile: { provider: 'gemini' }, ok: true },
  ]);
  api.agentModels.mockResolvedValue([
    { id: 'gpt-5.5', name: 'GPT 5.5', efforts: [] },
    { id: 'gpt-5.4', name: 'GPT 5.4', efforts: [] },
  ]);
  api.createTask.mockResolvedValue({ id: 1 });
  await act(async () =>
    root.render(<NewTaskDialog settings={settings} onClose={() => {}} onCreated={() => {}} />),
  );
  act(() => type(container.querySelector('textarea')!, 'Add greeting'));
  act(() => type(container.querySelector<HTMLInputElement>('#repo-path')!, '/repo'));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it('sends the explicitly selected cross-platform worker model pool', async () => {
  const codex = [...container.querySelectorAll('label.check')]
    .find((label) => label.textContent?.includes('codex'))!
    .querySelector<HTMLInputElement>('input')!;
  await act(async () => codex.click());
  const worker = codex.closest('div')!;
  const models = worker.querySelector('select')!;
  await act(async () => {
    models.value = 'gpt-5.5';
    models.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const add = [...worker.querySelectorAll('button')].find((b) => b.textContent === 'Add model')!;
  await act(async () => add.click());
  await act(async () => {
    models.value = 'gpt-5.4';
    models.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => add.click());
  await act(async () => container.querySelector('form')!.requestSubmit());
  expect(api.createTask.mock.calls[0]![0]).toMatchObject({
    workflow: 'pm',
    pm: {
      workers: [
        { agentId: 'claude', models: [null] },
        { agentId: 'codex', models: [null, 'gpt-5.5', 'gpt-5.4'] },
      ],
    },
  });
});

it('offers Gemini as a worker while keeping PM transport choices supported', () => {
  const pm = [...container.querySelectorAll('label.field')]
    .find((label) => label.querySelector('span')?.textContent === 'PM profile')!
    .querySelector('select')!;
  expect([...pm.options].map((option) => option.value)).toEqual(['claude', 'codex']);
  expect(
    [...container.querySelectorAll('label.check')].map((label) => label.textContent),
  ).toContain('gemini · gemini');
});

it('removes fixed-role and mode controls from task creation', () => {
  expect(container.textContent).not.toContain('Spec author');
  expect(container.textContent).not.toContain('Designer');
  expect(container.querySelector('input[name="mode"]')).toBeNull();
});
