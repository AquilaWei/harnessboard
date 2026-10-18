// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
// Choosing the agent that implements while the implementer is out of quota.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, Settings, TaskView } from '@harnessboard/shared';
import { NewTaskDialog } from '../src/components/NewTaskDialog';
import { TaskAgentsEditor } from '../src/components/TaskAgentsEditor';
import '../src/i18n';

const api = vi.hoisted(() => ({
  agents: vi.fn(),
  agentModels: vi.fn(),
  createTask: vi.fn(),
  folders: vi.fn(),
  inspectFolder: vi.fn(),
  setAgents: vi.fn(),
}));
vi.mock('../src/api', () => ({ api }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings = {
  defaultReviewer: null,
  defaultImplementerFallback: 'codex',
  defaultContextPolicy: { size: 'medium' },
} as unknown as Settings;

const profile = { provider: 'claude-code', command: 'claude', model: null };
const agents: AgentInfo[] = [
  { id: 'claude', profile, ok: true, version: '1', error: null },
  { id: 'codex', profile, ok: true, version: '1', error: null },
] as AgentInfo[];

const task = {
  id: 1,
  status: 'backlog',
  agents: { implementer: 'claude', reviewer: null, maxReviewRounds: 2 },
  activity: null,
} as unknown as TaskView;

const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
};

const choose = (select: HTMLSelectElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  api.agents.mockResolvedValue(agents);
  api.agentModels.mockResolvedValue([]);
  api.createTask.mockResolvedValue({ id: 7 });
  api.setAgents.mockResolvedValue(task);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

/** The select labelled `label`. */
const select = (label: string) =>
  [...container.querySelectorAll('label.field')]
    .find((field) => field.querySelector('span')?.textContent === label)!
    .querySelector('select')!;

const fallbackSelect = () => select('When the implementer is out of quota');

describe('NewTaskDialog implementer fallback', () => {
  const openDialog = async () => {
    await act(async () =>
      root.render(<NewTaskDialog settings={settings} onClose={() => {}} onCreated={() => {}} />),
    );
    act(() => type(container.querySelector('textarea')!, 'Add a settings page'));
    act(() => type(container.querySelector<HTMLInputElement>('.input-row input')!, '/repo'));
  };

  const submit = async () => {
    await act(async () => container.querySelector('form')!.requestSubmit());
  };

  it('starts at the configured default', async () => {
    await openDialog();
    expect(fallbackSelect().value).toBe('codex');
  });

  it('sends no fallback when waiting for the quota is chosen', async () => {
    await openDialog();
    act(() => choose(fallbackSelect(), ''));
    await submit();
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ implementerFallback: null });
  });

  it('does not offer the implementer as its own fallback', async () => {
    await openDialog();
    const ids = [...fallbackSelect().options].map((o) => o.value);
    expect(ids).toEqual(['', 'codex']);
  });

  it('drops the fallback when it becomes the implementer', async () => {
    await openDialog();
    act(() => choose(select('Implementer'), 'codex'));
    expect(fallbackSelect().value).toBe('');
  });
});

describe('TaskAgentsEditor implementer fallback', () => {
  const render = async (view: TaskView) =>
    act(async () =>
      root.render(<TaskAgentsEditor task={view} onSaved={() => {}} onError={() => {}} />),
    );

  it('shows the fallback of a task', async () => {
    await render({ ...task, agents: { ...task.agents, implementerFallback: 'codex' } });
    const lines = [...container.querySelectorAll('.tool-rules .mono')].map((s) => s.textContent);
    expect(lines).toContain('Out of quota: codex');
  });

  it('saves the chosen fallback while a session is open', async () => {
    await render({ ...task, status: 'running' } as TaskView);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.tool-rules button')!.click(),
    );
    act(() => choose(fallbackSelect(), 'codex'));
    await act(async () => container.querySelector<HTMLButtonElement>('.btn.primary')!.click());
    expect(api.setAgents.mock.calls[0]).toEqual([
      1,
      expect.objectContaining({ implementerFallback: 'codex' }),
    ]);
  });
});
