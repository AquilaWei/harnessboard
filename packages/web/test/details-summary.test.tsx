// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { TaskDetail } from '@harnessboard/shared';
import { Details } from '../src/components/Details';
import '../src/i18n';

vi.mock('../src/components/TaskRepositoryEditor', () => ({ TaskRepositoryEditor: () => null }));
vi.mock('../src/components/TaskContextEditor', () => ({ TaskContextEditor: () => null }));
vi.mock('../src/components/PmDetails', () => ({ PmDetails: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = {
  workflow: 'pm',
  sessionCount: 0,
  workspace: 'worktree',
  permission: { allowedTools: ['Bash(secret-command:*)'], skipPermissions: false },
  usage: {
    byModel: {
      'reported-model': { input: 100, output: 200, cacheRead: 300, cacheWrite: 400, costUsd: 0.41 },
      'unknown-cost-model': { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
    },
  },
} as unknown as TaskDetail;

it('shows one row per model with total tokens and estimated cost', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Details task={task} onSaved={vi.fn()} onError={vi.fn()} />));
    expect(container.querySelectorAll('thead th')).toHaveLength(3);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.querySelector('tbody tr')?.textContent).toContain('reported-model');
    expect(container.querySelector('tbody tr')?.textContent).toContain('1k');
    expect(container.querySelector('tbody tr')?.textContent).toContain('~$0.41');
    expect(container.querySelectorAll('tbody tr')[1]?.textContent).toContain('Not recorded');
  } finally {
    await act(async () => root.unmount());
  }
});

it('omits allowed tool rules from task details', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Details task={task} onSaved={vi.fn()} onError={vi.fn()} />));
    expect(container.textContent).not.toContain('secret-command');
    expect(container.querySelector('.agent-settings')?.hasAttribute('open')).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
