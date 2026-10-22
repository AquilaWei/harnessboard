// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import type { TaskView } from '@harnessboard/shared';
import { AgentTeam } from '../src/components/AgentTeam';
import '../src/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const task = {
  id: 1,
  status: 'running',
  pm: { agentId: 'claude', model: 'pm-model' },
  context: null,
  work: [
    {
      id: 'worker',
      agentId: 'codex',
      model: 'configured-model',
      status: 'awaiting_children',
      goal: 'Implement transfer',
      scope: 'core',
      acceptance: 'Tests pass',
      activity: 'Checking child results',
      sessionId: 'worker-session',
      usage: {
        runs: 2,
        agentMs: 2000,
        elapsedMs: 3000,
        tokens: { input: 100, output: 200, cacheRead: 30, cacheWrite: 10 },
        costUsd: 0.04,
        byModel: {
          'actual-model': { input: 100, output: 200, cacheRead: 30, cacheWrite: 10, costUsd: 0.04 },
        },
      },
    },
    {
      id: 'child',
      parentWorkId: 'worker',
      agentId: 'claude',
      model: null,
      status: 'failed',
      goal: 'Review protocol',
      scope: 'docs',
      acceptance: 'Identify risks',
      summary: 'Protocol needs correction',
      sessionId: 'child-session',
    },
  ],
} as unknown as TaskView;
const container = document.createElement('div');
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.render(null));
});
const render = () => act(async () => root.render(<AgentTeam task={task} events={[]} />));

it('renders PM, worker and subagent in their reporting hierarchy', async () => {
  await render();
  expect(container.querySelectorAll('.agent-node')).toHaveLength(3);
  expect(
    container
      .querySelector('[data-agent-id="worker"]')
      ?.closest('li')
      ?.querySelector('[data-agent-id="child"]'),
  ).not.toBeNull();
  expect(container.textContent).toContain('Waiting for subagents');
});

it('shows the selected agents own models and token breakdown', async () => {
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-agent-id="worker"]')!.click(),
  );
  const inspector = container.querySelector('.agent-inspector')!;
  expect(inspector.textContent).toContain('configured-model');
  expect(inspector.textContent).toContain('actual-model');
  expect(inspector.textContent).toContain('in 100, out 200, cache read 30, cache write 10');
  expect(inspector.textContent).toContain('Checking child results');
  expect(inspector.textContent).not.toContain('Protocol needs correction');
});

it('shows missing usage as unreported rather than zero', async () => {
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-agent-id="child"]')!.click(),
  );
  expect(container.querySelector('.agent-inspector')?.textContent).toContain('Not recorded');
  expect(container.querySelector('.agent-inspector')?.textContent).toContain(
    'Protocol needs correction',
  );
});

it('preserves branch collapse when returning from an agent detail', async () => {
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Collapse Worker · codex"]')!.click(),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-agent-id="worker"]')!.click(),
  );
  await act(async () => container.querySelector<HTMLButtonElement>('.agent-back')!.click());
  expect(container.querySelector('[data-agent-id="child"]')).toBeNull();
  expect(
    container.querySelector('[aria-label="Expand Worker · codex"]')?.getAttribute('aria-expanded'),
  ).toBe('false');
});
