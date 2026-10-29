// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { TaskDetail } from '@harnessboard/shared';
import { TaskRepositoryEditor } from '../src/components/TaskRepositoryEditor';
import '../src/i18n';

const api = vi.hoisted(() => ({
  setRepository: vi.fn().mockResolvedValue({}),
  inspectFolder: vi.fn().mockResolvedValue(null),
}));
vi.mock('../src/api', () => ({ api }));
vi.mock('../src/components/FolderField', () => ({
  FolderField: ({ onChange }: { onChange: (path: string) => void }) => (
    <button type="button" onClick={() => onChange('/new/project')}>
      Choose project
    </button>
  ),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.clearAllMocks());

it('saves the chosen folder and refreshes the task without starting implementation', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const onSaved = vi.fn();
  const onError = vi.fn();
  const task = {
    id: 33,
    repoPath: '/old/project',
    operations: { repository: { visible: true, enabled: true, reason: null } },
  } as TaskDetail;
  try {
    await act(async () =>
      root.render(<TaskRepositoryEditor task={task} onSaved={onSaved} onError={onError} />),
    );
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(api.setRepository).toHaveBeenCalledWith(33, '/new/project');
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it('explains why an active discussion must stop and hides the edit form', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const task = {
    repoPath: '/old/project',
    operations: {
      repository: {
        visible: true,
        enabled: false,
        reason: 'Stop the task before changing its project folder',
      },
    },
  } as TaskDetail;
  try {
    await act(async () =>
      root.render(<TaskRepositoryEditor task={task} onSaved={vi.fn()} onError={vi.fn()} />),
    );
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).toContain('Stop the task');
  } finally {
    await act(async () => root.unmount());
  }
});
