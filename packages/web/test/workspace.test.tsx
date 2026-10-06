// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings, TaskView } from '@harnessboard/shared';
import { NewTaskDialog } from '../src/components/NewTaskDialog';
import { TaskCard } from '../src/components/TaskCard';
import '../src/i18n';

const api = vi.hoisted(() => ({
  agents: vi.fn(),
  createTask: vi.fn(),
  folders: vi.fn(),
  inspectFolder: vi.fn(),
}));
vi.mock('../src/api', () => ({ api }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings = {
  defaultReviewer: null,
  defaultContextPolicy: { size: 'medium' },
} as unknown as Settings;

const card = (workspace: TaskView['workspace']) =>
  ({
    id: 1,
    title: 'Fix the login',
    status: 'backlog',
    mode: 'single',
    workspace,
    baseRef: 'main',
    agents: { implementer: 'claude', reviewer: null, maxReviewRounds: 2 },
    activity: null,
    context: null,
    loop: null,
    permissionRequests: [],
  }) as unknown as TaskView;

const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  api.agents.mockResolvedValue([]);
  api.createTask.mockResolvedValue({ id: 7 });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

const openDialog = async () => {
  await act(async () =>
    root.render(<NewTaskDialog settings={settings} onClose={() => {}} onCreated={() => {}} />),
  );
  act(() => type(container.querySelector('textarea')!, 'Fix the login'));
  act(() => type(container.querySelector<HTMLInputElement>('.input-row input')!, '/repo'));
};

const workspaceRadio = (value: string) =>
  container.querySelector<HTMLInputElement>(`input[name="workspace"][value="${value}"]`)!;

const submit = async () => {
  await act(async () => container.querySelector('form')!.requestSubmit());
};

describe('NewTaskDialog workspace choice', () => {
  it('offers a new branch and the current branch, with the new branch chosen', async () => {
    await openDialog();
    const labels = [...container.querySelectorAll('input[name="workspace"]')].map(
      (input) => input.closest('label')!.querySelector('strong')!.textContent,
    );
    expect(labels).toEqual([
      'Work on a new branch (recommended)',
      'Work directly on the current branch',
    ]);
    expect(workspaceRadio('worktree').checked).toBe(true);
  });

  it('sends no workspace when the new branch is kept', async () => {
    await openDialog();
    await submit();
    expect(api.createTask.mock.calls[0]![0]).not.toHaveProperty('workspace');
  });

  it('sends the base workspace when working directly on the branch is chosen', async () => {
    await openDialog();
    await act(async () => workspaceRadio('base').click());
    await submit();
    expect(api.createTask.mock.calls[0]![0]).toMatchObject({ workspace: 'base' });
  });
});

describe('TaskCard workspace', () => {
  const render = async (task: TaskView) =>
    act(async () =>
      root.render(
        <TaskCard
          task={task}
          onOpen={() => {}}
          onAction={() => {}}
          onDragStart={() => {}}
          onDragEnd={() => {}}
          dragging={false}
        />,
      ),
    );

  it('shows the branch a base task works on', async () => {
    await render(card('base'));
    expect(container.querySelector('.card-sub')?.textContent).toContain('on main');
  });

  it('shows no branch badge for a worktree task', async () => {
    await render(card('worktree'));
    expect(container.querySelector('.card-sub')?.textContent).not.toContain('on main');
  });
});
