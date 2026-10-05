// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskView } from '@harnessboard/shared';
import type { PhoneTab } from '../src/board';
import { Board } from '../src/components/Board';
import '../src/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card = (id: number, title: string, status: TaskView['status']) =>
  ({
    id,
    title,
    status,
    mode: 'single',
    agents: { implementer: 'claude', reviewer: null, maxReviewRounds: 2 },
    activity: null,
    context: null,
    loop: null,
    permissionRequests: [],
  }) as unknown as TaskView;

const tasks = [card(1, 'Fix the login', 'review'), card(2, 'Answer me', 'awaiting_permission')];

/** A window as wide as `phone` says: `matchMedia` answers the board's phone-width query. */
const width = (phone: boolean) =>
  vi.stubGlobal('matchMedia', () => ({
    matches: phone,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

let root: Root;
let container: HTMLElement;

const render = async (phoneTab: PhoneTab) => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <Board
        tasks={tasks}
        phoneTab={phoneTab}
        onPhoneTab={() => {}}
        onOpen={() => {}}
        onAction={() => {}}
        onInvalidMove={() => {}}
        onNewTask={() => {}}
      />,
    ),
  );
};

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Board at phone width', () => {
  it('shows the four tabs', async () => {
    width(true);
    await render('waiting');
    const tabs = [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Waiting for you 1', 'In progress 0', 'Review 1', 'Done 0']);
  });

  it('shows only the tasks of the chosen tab', async () => {
    width(true);
    await render('review');
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain('Fix the login');
    expect(container.textContent).not.toContain('Answer me');
  });
});

describe('Board at desktop width', () => {
  it('shows the four stages side by side without tabs', async () => {
    width(false);
    await render('waiting');
    expect(container.querySelectorAll('section.stage')).toHaveLength(4);
    expect(container.querySelector('[role="tab"]')).toBeNull();
  });
});
