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

interface Options {
  initialTab?: DrawerTab;
  onAction?: (detail: TaskDetail, action: string) => Promise<unknown>;
  onClose?: () => void;
}

const renderDrawer = async (detail: TaskDetail, options: Options = {}) => {
  api.task.mockResolvedValue(detail);
  await act(async () =>
    root.render(
      <TaskDrawer
        taskId={1}
        initialTab={options.initialTab ?? 'timeline'}
        onAction={(current, action) =>
          (options.onAction ?? (() => Promise.resolve()))(current, action)
        }
        onClose={options.onClose ?? (() => {})}
        onError={() => {}}
      />,
    ),
  );
};

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label);

/** Opens the More menu, where the secondary actions wait. */
const openMore = () => act(async () => button('⋯ More')!.click());

/** The labels of the buttons shown on the actions row, outside the More menu. */
const mainLabels = () =>
  [...container.querySelectorAll('.actions > button')].map((b) => b.textContent);

/** The labels of the items in the open More menu. */
const menuLabels = () =>
  [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);

const tabLabels = () =>
  [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);

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

  it('when a tool use awaits permission expect the request above the description', async () => {
    await renderDrawer(
      task({
        status: 'awaiting_permission',
        permissionRequests: [
          {
            requestId: 'r1',
            sessionId: 's1',
            toolName: 'Bash',
            summary: 'pnpm run build',
            suggestedRules: [],
            risk: null,
            ts: 0,
          },
        ],
      }),
    );
    const request = container.querySelector('.status-box .permission')!;
    const description = container.querySelector('.status-box .description')!;
    expect(request.compareDocumentPosition(description)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('when a review has findings expect them above the description', async () => {
    await renderDrawer(
      task({
        status: 'review',
        lastReview: {
          agentId: 'codex',
          verdict: 'changes',
          round: 1,
          findings: '- Fix the redirect',
        } as TaskDetail['lastReview'],
      }),
    );
    const findings = container.querySelector('.status-box .status-review')!;
    const description = container.querySelector('.status-box .description')!;
    expect(findings.compareDocumentPosition(description)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('when the PM asks a question expect the question above the description', async () => {
    await renderDrawer(
      task({
        workflow: 'pm',
        status: 'awaiting_approval',
        pmQuestion: { kind: 'question', message: 'Which branch should it use?' },
      }),
    );
    const question = container.querySelector('.status-box .reply')!;
    const description = container.querySelector('.status-box .description')!;
    expect(question.textContent).toBe('Which branch should it use?');
    expect(question.compareDocumentPosition(description)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('TaskDrawer tabs', () => {
  it('when the panel opens expect no Log tab', async () => {
    await renderDrawer(task({}));
    expect(tabLabels()).not.toContain('Log');
  });

  it('when the panel opens expect the tabs in the agreed order with Details last', async () => {
    await renderDrawer(task({}));
    expect(tabLabels()).toEqual(['Timeline', 'Criteria', 'Changes', 'Chat', 'Notes', 'Details']);
  });

  it('when the window was opened on the Log tab expect the timeline shown', async () => {
    await renderDrawer(task({}), { initialTab: 'log' });
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Timeline',
    );
  });
});

describe('TaskDrawer main actions', () => {
  // Without a session there is no Chat button, so the row shows only the main actions.
  it.each([
    { status: 'backlog', labels: ['Plan the spec'] },
    { status: 'pending', labels: ['Start'] },
    { status: 'queued', labels: ['Stop'] },
    { status: 'running', labels: ['Stop'] },
    { status: 'waiting_quota', labels: ['Stop'] },
    { status: 'awaiting_permission', labels: ['Stop'] },
    { status: 'awaiting_approval', labels: ['Review criteria'] },
    { status: 'review', labels: ['Changes'] },
    { status: 'failed', labels: ['Retry'] },
    { status: 'stopped', labels: ['Retry'] },
    { status: 'paused_safety', labels: ['Resume'] },
    { status: 'done', labels: ['Reopen as pending'] },
  ])(
    'when the status is $status expect $labels as the main actions',
    async ({ status, labels }) => {
      await renderDrawer(task({ status, latestSessionId: null } as Partial<TaskDetail>));
      expect(mainLabels()).toEqual(labels);
    },
  );

  it('when a review can be merged expect Merge and Changes as the main actions', async () => {
    await renderDrawer(
      task({
        status: 'review',
        latestSessionId: null,
        operations: {
          merge: { visible: true, enabled: true, reason: null },
          complete: { visible: true, enabled: true, reason: null },
        },
      } as Partial<TaskDetail>),
    );
    expect(mainLabels()).toEqual(['Merge into main', 'Changes']);
  });

  it('when a review has no merge expect Mark done beside Changes', async () => {
    await renderDrawer(
      task({
        status: 'review',
        latestSessionId: null,
        branch: null,
        operations: {
          merge: { visible: false, enabled: false, reason: null },
          complete: { visible: true, enabled: true, reason: null },
        },
      } as Partial<TaskDetail>),
    );
    expect(mainLabels()).toEqual(['Changes', 'Mark done']);
  });

  it('when a PM task waits with nothing to approve expect Mark done as the main action', async () => {
    await renderDrawer(
      task({
        workflow: 'pm',
        status: 'awaiting_approval',
        branch: null,
        latestSessionId: null,
        operations: {
          merge: { visible: false, enabled: false, reason: null },
          complete: { visible: true, enabled: true, reason: null },
        },
      } as Partial<TaskDetail>),
    );
    expect(mainLabels()).toEqual(['Mark done']);
  });

  it('when a session exists expect Chat beside the main action', async () => {
    await renderDrawer(task({ status: 'pending' }));
    expect(mainLabels()).toEqual(['Start', 'Chat']);
  });
});

describe('TaskDrawer More menu', () => {
  it('when More is pressed expect the menu open', async () => {
    await renderDrawer(task({ status: 'failed' }));
    await openMore();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('when More is pressed expect the trigger to report it is expanded', async () => {
    await renderDrawer(task({ status: 'failed' }));
    await openMore();
    expect(button('⋯ More')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('when a failed task opens More expect Put in pending among its items', async () => {
    await renderDrawer(task({ status: 'failed' }));
    await openMore();
    expect(menuLabels()).toContain('Put in pending');
  });

  it('when a failed task opens More expect Back to draft among its items', async () => {
    await renderDrawer(task({ status: 'failed' }));
    await openMore();
    expect(menuLabels()).toContain('Back to draft');
  });

  it('when a task in review opens More expect Run again among its items', async () => {
    await renderDrawer(task({ status: 'review', lastReview: null }));
    await openMore();
    expect(menuLabels()).toContain('Run again');
  });

  it('when a pending task opens More expect Stop among its items', async () => {
    await renderDrawer(task({ status: 'pending' }));
    await openMore();
    expect(menuLabels()).toContain('Stop');
  });

  it('when a pending task opens More expect Delete in it', async () => {
    await renderDrawer(task({ status: 'pending' }));
    await openMore();
    expect(container.querySelector('.task-menu-pop')?.textContent).toContain('Delete');
  });

  it('when a running task opens More expect no Delete in it', async () => {
    await renderDrawer(task({ status: 'running' }));
    await openMore();
    expect(container.querySelector('.task-menu-pop')?.textContent).not.toContain('Delete');
  });

  it('when a worktree exists expect Clean caches in More', async () => {
    await renderDrawer(task({ status: 'pending', worktreePath: '/tmp/worktree-1' }));
    await openMore();
    expect(container.querySelector('.task-menu-pop')?.textContent).toContain('Clean caches');
  });

  it('when an item is chosen expect the menu closed', async () => {
    await renderDrawer(task({ status: 'failed' }));
    await openMore();
    await act(async () => button('Put in pending')!.click());
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('when an item is chosen expect its action sent for the task', async () => {
    const onAction = vi.fn<(detail: TaskDetail, action: string) => Promise<unknown>>(() =>
      Promise.resolve(),
    );
    await renderDrawer(task({ status: 'failed' }), { onAction });
    await openMore();
    await act(async () => button('Put in pending')!.click());
    expect(onAction.mock.calls.map(([, action]) => action)).toEqual(['pend']);
  });

  it('when Escape is pressed expect the menu closed', async () => {
    await renderDrawer(task({ status: 'failed' }));
    await openMore();
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('when Escape is pressed with the menu open expect the panel left open', async () => {
    const onClose = vi.fn();
    await renderDrawer(task({ status: 'failed' }), { onClose });
    await openMore();
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('when a press lands outside the menu expect the menu closed', async () => {
    await renderDrawer(task({ status: 'failed' }));
    await openMore();
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});
