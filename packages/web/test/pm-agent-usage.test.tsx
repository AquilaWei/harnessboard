// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { TaskView } from '@harnessboard/shared';
import { PmAgentUsage } from '../src/components/PmAgentUsage';
import '../src/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('separates PM and worker usage and keeps the full instruction collapsed', async () => {
  const task = {
    status: 'running',
    pm: { agentId: 'claude', model: 'configured-model' },
    pmUsage: {
      runs: 2,
      agentMs: 30000,
      costUsd: 0.41,
      tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
      byModel: {
        'reported-model': { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, costUsd: 0.41 },
      },
    },
    work: [
      {
        id: 'worker-1',
        agentId: 'codex',
        model: 'worker-model',
        status: 'running',
        goal: 'Long implementation instructions',
        scope: 'src',
        summary: null,
        head: null,
      },
    ],
  } as unknown as TaskView;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<PmAgentUsage task={task} />));
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.querySelector('tbody tr')?.textContent).toContain('PM · claude');
    expect(container.querySelector('tbody tr')?.textContent).toContain('reported-model');
    expect(container.querySelector('tbody tr')?.textContent).toContain('300');
    expect(container.querySelector('tbody tr')?.textContent).toContain('~$0.41');
    expect(container.querySelector('tbody tr')?.textContent).toContain('30s');
    expect(container.querySelectorAll('tbody tr')[1]?.textContent).toContain('Not recorded');
    expect(container.querySelector('details')?.open).toBe(false);
    expect(container.querySelector('summary')?.textContent).not.toContain('Long implementation');
  } finally {
    await act(async () => root.unmount());
  }
});
