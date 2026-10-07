// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
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
  defaultContextPolicy: { size: 'medium' },
} as unknown as Settings;

const profile = { provider: 'claude-code', command: 'claude', model: null };
const agents: AgentInfo[] = [
  { id: 'claude', profile, ok: true, version: '1', error: null },
  { id: 'artist', profile, ok: true, version: '1', error: null },
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

/** The select labelled "Designer". */
const designerSelect = () =>
  [...container.querySelectorAll('label.field')]
    .find((label) => label.querySelector('span')?.textContent === 'Designer')!
    .querySelector('select')!;

const selectedText = (select: HTMLSelectElement) => select.selectedOptions[0]!.textContent;

describe('NewTaskDialog designer', () => {
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

  it('defaults to None', async () => {
    await openDialog();
    expect(selectedText(designerSelect())).toBe('None');
  });

  it('sends no designer when None is kept', async () => {
    await openDialog();
    await submit();
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ designer: null });
  });

  it('sends the chosen designer', async () => {
    await openDialog();
    act(() => choose(designerSelect(), 'artist'));
    await submit();
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ designer: 'artist' });
  });
});

describe('TaskAgentsEditor designer', () => {
  const render = async (view: TaskView) =>
    act(async () =>
      root.render(<TaskAgentsEditor task={view} onSaved={() => {}} onError={() => {}} />),
    );

  const edit = async () => {
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.tool-rules button')!.click(),
    );
  };

  it('shows that the task has no designer', async () => {
    await render(task);
    const lines = [...container.querySelectorAll('.tool-rules .mono')].map((s) => s.textContent);
    expect(lines).toContain('Designer: none');
  });

  it('shows the designer of a task with one', async () => {
    await render({ ...task, agents: { ...task.agents, designer: 'artist' } });
    const lines = [...container.querySelectorAll('.tool-rules .mono')].map((s) => s.textContent);
    expect(lines).toContain('Designer: artist · profile default');
  });

  it('starts the designer choice at None', async () => {
    await render(task);
    await edit();
    expect(selectedText(designerSelect())).toBe('None');
  });

  it('saves the chosen designer', async () => {
    await render(task);
    await edit();
    act(() => choose(designerSelect(), 'artist'));
    await act(async () => container.querySelector<HTMLButtonElement>('.btn.primary')!.click());
    expect(api.setAgents.mock.calls[0]).toEqual([
      1,
      expect.objectContaining({ designer: 'artist' }),
    ]);
  });
});
