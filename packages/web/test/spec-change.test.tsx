// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpecChangeProposal, TaskDetail } from '@harnessboard/shared';
import { CriteriaReview } from '../src/components/CriteriaReview';
import { TaskDrawer } from '../src/components/TaskDrawer';
import '../src/i18n';

const api = vi.hoisted(() => ({
  task: vi.fn(),
  timeline: vi.fn(),
  events: vi.fn(),
  approveCriteria: vi.fn(),
  rejectSpecChange: vi.fn(),
  requestSpecRevision: vi.fn(),
  planFeedback: vi.fn(),
}));
vi.mock('../src/api', () => ({ api }));
vi.mock('../src/live', () => ({ useLiveEvents: () => {}, useThrottled: (fn: () => void) => fn }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const change: SpecChangeProposal = {
  from: 'user',
  reason: 'Accept a phone number too',
  previous: '- logs in with an email',
  criteria: '- logs in with an email or a phone number',
  reply: 'Here is the revised list.',
  onReject: 'queued',
  sessionId: 's2',
  requestId: 9,
};

const task = (fields: Partial<TaskDetail>) =>
  ({
    id: 4,
    title: 'Fix the login',
    status: 'review',
    mode: 'single',
    confirmPlan: true,
    acceptance: '- logs in with an email',
    specFile: 'docs/specs/4-fix-the-login.md',
    specChange: null,
    specRevisionPending: false,
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
    permissionRequests: [],
    usage: { runs: 1, agentMs: 0, elapsedMs: null, tokens: null, costUsd: null, byModel: {} },
    sessionCount: 1,
    latestSessionId: null,
    sessions: [],
    features: null,
    ...fields,
  }) as unknown as TaskDetail;

const type = (field: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  api.timeline.mockResolvedValue([]);
  api.events.mockResolvedValue([]);
  api.approveCriteria.mockResolvedValue({});
  api.rejectSpecChange.mockResolvedValue({});
  api.requestSpecRevision.mockResolvedValue({});
  api.planFeedback.mockResolvedValue({});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

const renderReview = (detail: TaskDetail) =>
  act(async () =>
    root.render(<CriteriaReview task={detail} onDone={() => {}} onError={() => {}} />),
  );

const renderDrawer = async (detail: TaskDetail) => {
  api.task.mockResolvedValue(detail);
  await act(async () =>
    root.render(
      <TaskDrawer
        taskId={4}
        initialTab="timeline"
        onAction={() => Promise.resolve()}
        onClose={() => {}}
        onError={() => {}}
      />,
    ),
  );
};

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label);

describe('TaskDrawer spec change action', () => {
  it('offers Change the spec for a task in review with a spec file', async () => {
    await renderDrawer(task({}));
    expect(button('Change the spec')).toBeDefined();
  });

  it('offers no Change the spec before the spec file is written', async () => {
    await renderDrawer(task({ specFile: null }));
    expect(button('Change the spec')).toBeUndefined();
  });

  it('offers no Change the spec for a done task', async () => {
    await renderDrawer(task({ status: 'done' }));
    expect(button('Change the spec')).toBeUndefined();
  });

  it('opens the criteria tab with the request form', async () => {
    await renderDrawer(task({}));
    await act(async () => button('Change the spec')!.click());
    expect(button('Ask for the change')).toBeDefined();
  });
});

describe('CriteriaReview spec change request', () => {
  it('sends the typed message as a spec change request', async () => {
    await renderReview(task({}));
    act(() => type(container.querySelector('textarea')!, '  Accept a phone number too '));
    await act(async () => button('Ask for the change')!.click());
    expect(api.requestSpecRevision.mock.calls).toEqual([[4, 'Accept a phone number too']]);
  });

  it('keeps the send button disabled while the message is empty', async () => {
    await renderReview(task({}));
    expect(button('Ask for the change')!.disabled).toBe(true);
  });

  it('says the request is with the spec author while it waits', async () => {
    await renderReview(task({ status: 'queued', specRevisionPending: true }));
    expect(container.textContent).toContain(
      'Your request is with the spec author. Its proposal appears here.',
    );
  });
});

describe('CriteriaReview proposed spec change', () => {
  const waiting = () => task({ status: 'awaiting_approval', specChange: change });

  it('shows the current and proposed criteria side by side', async () => {
    await renderReview(waiting());
    const columns = container.querySelectorAll('.spec-compare > section');
    expect([
      columns[0]!.querySelector('li')!.textContent,
      columns[1]!.querySelector('textarea')!.value,
    ]).toEqual(['logs in with an email', '- logs in with an email or a phone number']);
  });

  it('shows why the change was asked for', async () => {
    await renderReview(waiting());
    expect(container.querySelector('.spec-reason')!.textContent).toBe('Accept a phone number too');
  });

  it('approves the proposed criteria as edited', async () => {
    await renderReview(waiting());
    act(() => type(container.querySelector('.spec-compare textarea')!, '- logs in with a phone'));
    await act(async () => button('Approve change')!.click());
    expect(api.approveCriteria.mock.calls).toEqual([[4, '- logs in with a phone']]);
  });

  it('rejects the change', async () => {
    await renderReview(waiting());
    await act(async () => button('Reject change')!.click());
    expect(api.rejectSpecChange.mock.calls).toEqual([[4]]);
  });

  it('sends a reply to the spec author', async () => {
    await renderReview(waiting());
    const reply = container.querySelectorAll('textarea')[1]!;
    act(() => type(reply, 'Keep email first'));
    await act(async () => button('Send feedback')!.click());
    expect(api.planFeedback.mock.calls).toEqual([[4, 'Keep email first']]);
  });

  it('keeps approve disabled when the reply had no criteria', async () => {
    await renderReview(
      task({ status: 'awaiting_approval', specChange: { ...change, criteria: null } }),
    );
    expect(button('Approve change')!.disabled).toBe(true);
  });

  it("names the implementer's proposal as its own", async () => {
    await renderReview(
      task({ status: 'awaiting_approval', specChange: { ...change, from: 'implementer' } }),
    );
    expect(container.querySelector('h3')!.textContent).toBe('The implementer proposes a change');
  });
});
