// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrawerTab } from '../src/components/TaskDrawer';
import type { TaskDetail } from '@harnessboard/shared';
import { TaskDrawer } from '../src/components/TaskDrawer';
import '../src/i18n';

const api = vi.hoisted(() => ({
  task: vi.fn(),
  timeline: vi.fn(),
  events: vi.fn(),
  diff: vi.fn(),
  commits: vi.fn(),
}));
vi.mock('../src/api', () => ({ api }));
vi.mock('../src/components/ChatPanel', () => ({ ChatPanel: () => null }));
vi.mock('../src/live', () => ({ useLiveEvents: () => {}, useThrottled: (fn: () => void) => fn }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A single-mode task with a criteria list and a session, so every ordinary tab is offered.
const task = (fields: Partial<TaskDetail>) =>
  ({
    id: 1,
    title: 'Fix the login',
    status: 'running',
    mode: 'single',
    workflow: 'task',
    confirmPlan: true,
    acceptance: '- logs in with an email',
    specFile: 'docs/specs/1-fix-the-login.md',
    workspace: 'worktree',
    worktreePath: null,
    branch: 'task/1',
    baseRef: 'main',
    agents: { implementer: 'claude', reviewer: null, maxReviewRounds: 2 },
    activity: null,
    context: null,
    loop: null,
    lastReview: null,
    reviewPending: false,
    lastNotice: null,
    plan: null,
    criteria: null,
    merge: null,
    operations: {
      merge: { visible: false, enabled: false, reason: null },
      complete: { visible: false, enabled: false, reason: null },
    },
    permissionRequests: [],
    usage: { runs: 1, agentMs: 0, elapsedMs: null, tokens: null, costUsd: null, byModel: {} },
    sessionCount: 1,
    latestSessionId: 's1',
    sessions: [],
    features: null,
    permission: { allowedTools: [], skipPermissions: false },
    ...fields,
  }) as unknown as TaskDetail;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  api.timeline.mockResolvedValue([]);
  api.events.mockResolvedValue([]);
  api.diff.mockResolvedValue(null);
  api.commits.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

const renderDrawer = async (detail: TaskDetail, initialTab: DrawerTab = 'timeline') => {
  api.task.mockResolvedValue(detail);
  await act(async () =>
    root.render(
      <TaskDrawer
        taskId={1}
        initialTab={initialTab}
        onAction={() => Promise.resolve()}
        onClose={() => {}}
        onError={() => {}}
      />,
    ),
  );
};

const tabLabels = () =>
  [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label);

// The failure reason is shown in the status sentence, so a long one makes a long description.
const longReason =
  'The verify command failed again after the reviewer asked for changes. '.repeat(3) +
  'Final detail.';

describe('TaskDrawer description', () => {
  it('when the description is long expect its end folded away', async () => {
    await renderDrawer(task({ status: 'failed', lastNotice: longReason }));
    expect(container.querySelector('.description')?.textContent).not.toContain('Final detail.');
  });

  it('when the description is long expect a Show more button', async () => {
    await renderDrawer(task({ status: 'failed', lastNotice: longReason }));
    expect(button('Show more')).toBeDefined();
  });

  it('when Show more is pressed expect the whole description', async () => {
    await renderDrawer(task({ status: 'failed', lastNotice: longReason }));
    await act(async () => button('Show more')!.click());
    expect(container.querySelector('.description')?.textContent).toContain('Final detail.');
  });

  it('when the description is short expect no Show more button', async () => {
    await renderDrawer(task({ status: 'running' }));
    expect(button('Show more')).toBeUndefined();
  });
});

describe('TaskDrawer status box', () => {
  it('when the status box renders expect no monitoring hint in it', async () => {
    await renderDrawer(task({}));
    expect(container.querySelector('.status-box')?.textContent).not.toContain(
      'Protection acts when usage is reported',
    );
  });
});

describe('TaskDrawer tabs', () => {
  it('when the panel opens expect no Log tab', async () => {
    await renderDrawer(task({}));
    expect(tabLabels()).not.toContain('Log');
  });

  it('when the panel opens expect the tabs in the agreed order with Details last', async () => {
    await renderDrawer(task({}));
    expect(tabLabels()).toEqual([
      'Timeline',
      'Criteria',
      'Changes',
      'Chat',
      'Notes',
      'Details',
    ]);
  });

  it('when the window was opened on the Log tab expect the timeline shown', async () => {
    await renderDrawer(task({}), 'log');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Timeline',
    );
  });
});
