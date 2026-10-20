// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
// Choosing the agent that implements while the implementer is out of quota.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, TaskView } from '@harnessboard/shared';
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

describe('TaskAgentsEditor implementer fallback', () => {
  const render = async (view: TaskView) =>
    act(async () =>
      root.render(<TaskAgentsEditor task={view} onSaved={() => {}} onError={() => {}} />),
    );

  it('shows the fallback of a task', async () => {
    await render({ ...task, agents: { ...task.agents, implementerFallback: 'codex' } });
    const lines = [...container.querySelectorAll('.tool-rules .mono')].map((s) => s.textContent);
    expect(lines).toContain('Out of quota: codex · profile default');
  });

  it('shows the fallback model and effort', async () => {
    await render({
      ...task,
      agents: {
        ...task.agents,
        implementerFallback: 'codex',
        implementerFallbackModel: 'gpt-5.5',
        implementerFallbackEffort: 'high',
      },
    });
    const lines = [...container.querySelectorAll('.tool-rules .mono')].map((s) => s.textContent);
    expect(lines).toContain('Out of quota: codex · gpt-5.5 · High');
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
