// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, ModelInfo, Settings, TaskView } from '@harnessboard/shared';
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

const agents: AgentInfo[] = [
  {
    id: 'claude',
    profile: { provider: 'claude-code', command: 'claude', model: null },
    ok: true,
    version: '1',
    error: null,
  },
] as AgentInfo[];

const effort = (id: string, name: string, note: string | null = null) => ({
  id,
  name,
  description: null,
  note,
});

const models: ModelInfo[] = [
  {
    id: 'opus',
    name: 'Opus 5.5',
    description: null,
    note: null,
    more: false,
    efforts: [
      effort('low', 'Low'),
      effort('medium', 'Medium', 'Recommended'),
      effort('high', 'High'),
      effort('xhigh', 'Extra'),
      effort('max', 'Max', '3.5× or more usage'),
    ],
    defaultEffort: null,
  },
  {
    id: 'haiku',
    name: 'Haiku 5.5',
    description: null,
    note: null,
    more: false,
    efforts: [],
    defaultEffort: null,
  },
  {
    id: 'mini',
    name: 'Mini',
    description: null,
    note: null,
    more: false,
    efforts: [effort('low', 'low'), effort('medium', 'medium')],
    defaultEffort: 'medium',
  },
  {
    id: 'sonnet',
    name: 'Sonnet 5.5',
    description: null,
    note: null,
    more: false,
    efforts: [effort('low', 'Low'), effort('high', 'High')],
    defaultEffort: null,
  },
];

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
  api.agentModels.mockResolvedValue(models);
  api.createTask.mockResolvedValue({ id: 7 });
  api.setAgents.mockResolvedValue(task);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

/** The select labelled `label` in the row of the field labelled `row`. */
const select = (row: string, label: string) => {
  const field = (scope: ParentNode, text: string) =>
    [...scope.querySelectorAll('label.field')].find(
      (l) => l.querySelector('span')?.textContent === text,
    );
  return field(field(container, row)!.closest('.row')!, label)?.querySelector('select') ?? null;
};
const modelSelect = () => select('Implementer', 'Implementer model')!;
const effortSelect = () => select('Implementer', 'Reasoning effort');
const optionTexts = (s: HTMLSelectElement) => [...s.options].map((o) => o.textContent);

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

describe('effort selector', () => {
  it('lists Default and the chosen model’s efforts with their notes', async () => {
    await openDialog();
    act(() => choose(modelSelect(), 'opus'));
    expect(optionTexts(effortSelect()!)).toEqual([
      'Default',
      'Low',
      'Medium (Recommended)',
      'High',
      'Extra',
      'Max (3.5× or more usage)',
    ]);
  });

  it('names the default effort when the model gives one, raising its first letter', async () => {
    await openDialog();
    act(() => choose(modelSelect(), 'mini'));
    expect(optionTexts(effortSelect()!)).toEqual(['Default (Medium)', 'Low', 'Medium']);
  });

  it('is hidden for the profile default when the profile names no model', async () => {
    await openDialog();
    expect(effortSelect()).toBeNull();
  });

  it('is hidden for a model without efforts', async () => {
    await openDialog();
    act(() => choose(modelSelect(), 'haiku'));
    expect(effortSelect()).toBeNull();
  });

  it('sends the chosen effort when the task is created', async () => {
    await openDialog();
    act(() => choose(modelSelect(), 'opus'));
    act(() => choose(effortSelect()!, 'high'));
    await submit();
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({
      implementerModel: 'opus',
      implementerEffort: 'high',
    });
  });

  it('sends no effort after Default is chosen again', async () => {
    await openDialog();
    act(() => choose(modelSelect(), 'opus'));
    act(() => choose(effortSelect()!, 'high'));
    act(() => choose(effortSelect()!, ''));
    await submit();
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ implementerEffort: null });
  });

  it('clears the effort when a model without efforts is chosen', async () => {
    await openDialog();
    act(() => choose(modelSelect(), 'opus'));
    act(() => choose(effortSelect()!, 'high'));
    act(() => choose(modelSelect(), 'haiku'));
    await submit();
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ implementerEffort: null });
  });

  it('resets the effort when the new model does not offer it', async () => {
    await openDialog();
    act(() => choose(modelSelect(), 'opus'));
    act(() => choose(effortSelect()!, 'high'));
    act(() => choose(modelSelect(), 'mini'));
    await submit();
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ implementerEffort: null });
  });

  it('keeps the effort when the new model offers it too', async () => {
    await openDialog();
    act(() => choose(modelSelect(), 'opus'));
    act(() => choose(effortSelect()!, 'high'));
    act(() => choose(modelSelect(), 'sonnet'));
    expect(effortSelect()!.value).toBe('high');
  });

  it('clears the effort when a model id is typed by hand', async () => {
    await openDialog();
    act(() => choose(modelSelect(), 'opus'));
    act(() => choose(effortSelect()!, 'high'));
    act(() => choose(modelSelect(), '__custom'));
    await submit();
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ implementerEffort: null });
  });
});

describe('TaskAgentsEditor effort', () => {
  const render = async (view: TaskView) =>
    act(async () =>
      root.render(<TaskAgentsEditor task={view} onSaved={() => {}} onError={() => {}} />),
    );

  const edit = async () => {
    await act(async () =>
      container.querySelector<HTMLButtonElement>('.tool-rules button')!.click(),
    );
  };

  const save = async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('.btn.primary')!.click());
  };

  const withAgents = (agentsPatch: object) =>
    ({ ...task, agents: { ...task.agents, ...agentsPatch } }) as TaskView;

  it('shows the effort next to the model in the summary', async () => {
    await render(withAgents({ implementerModel: 'Opus 5.5', implementerEffort: 'high' }));
    const lines = [...container.querySelectorAll('.tool-rules .mono')].map((s) => s.textContent);
    expect(lines).toContain('claude · Opus 5.5 · High');
  });

  it('shows no effort in the summary when it is unset', async () => {
    await render(withAgents({ implementerModel: 'opus' }));
    const lines = [...container.querySelectorAll('.tool-rules .mono')].map((s) => s.textContent);
    expect(lines).toContain('claude · opus');
  });

  it('starts at the stored effort', async () => {
    await render(withAgents({ implementerModel: 'opus', implementerEffort: 'max' }));
    await edit();
    expect(effortSelect()!.value).toBe('max');
  });

  it('sends the changed effort when saved', async () => {
    await render(withAgents({ implementerModel: 'opus' }));
    await edit();
    act(() => choose(effortSelect()!, 'xhigh'));
    await save();
    expect(api.setAgents.mock.calls[0]![1]).toMatchObject({
      implementerModel: 'opus',
      implementerEffort: 'xhigh',
    });
  });

  it('sends the reviewer’s effort for a task with a reviewer', async () => {
    await render(withAgents({ reviewer: 'claude', reviewerModel: 'sonnet' }));
    await edit();
    act(() => choose(select('Reviewer', 'Reasoning effort')!, 'low'));
    await save();
    expect(api.setAgents.mock.calls[0]![1]).toMatchObject({ reviewerEffort: 'low' });
  });
});
