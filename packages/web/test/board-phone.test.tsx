// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act, useState } from 'react';
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

const tasks = [
  card(1, 'Fix the login', 'review'),
  card(2, 'Answer me', 'awaiting_permission'),
  card(3, 'Finished', 'done'),
];

/** A window as wide as `phone` says: `matchMedia` answers the board's phone-width query. */
const width = (phone: boolean) =>
  vi.stubGlobal('matchMedia', () => ({
    matches: phone,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

let root: Root;
let container: HTMLElement;

const onTile = vi.fn();

function InteractiveBoard({ phoneTab }: { phoneTab: PhoneTab }) {
  const [stage, setStage] = useState<import('../src/board').Stage | null>(null);
  return (
    <Board
      tasks={tasks}
      phoneTab={phoneTab}
      tiledStage={stage}
      onTile={(next, ids) => {
        onTile(next, ids);
        setStage(stage === next ? null : next);
      }}
      onPhoneTab={() => {}}
      onOpen={() => {}}
      onAction={() => {}}
      onInvalidMove={() => {}}
      onNewTask={() => {}}
    />
  );
}

const render = async (phoneTab: PhoneTab) => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<InteractiveBoard phoneTab={phoneTab} />));
};

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Board at phone width', () => {
  it('shows the five tabs', async () => {
    width(true);
    await render('waiting');
    const tabs = [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['Waiting for you 1', 'Pending 0', 'In progress 0', 'Review 1', 'Done 1']);
  });

  it('shows only the tasks of the chosen tab', async () => {
    width(true);
    await render('review');
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain('Fix the login');
    expect(container.textContent).not.toContain('Answer me');
  });
});

describe('Board at desktop width', () => {
  it('shows the five stages side by side without tabs', async () => {
    width(false);
    await render('waiting');
    expect(container.querySelectorAll('section.stage')).toHaveLength(5);
    expect(container.querySelector('[role="tab"]')).toBeNull();
  });
});

it('tiles the attention stage when its header is clicked', async () => {
  width(false);
  await render('waiting');
  await act(async () =>
    container.querySelector<HTMLButtonElement>('#stage-attention h2 button')!.click(),
  );
  expect(onTile).toHaveBeenCalledWith('attention', [2, 1]);
});

it('keeps draft and done headers non-clickable', async () => {
  width(false);
  await render('waiting');
  expect(container.querySelector('#stage-draft h2 button, #stage-done h2 button')).toBeNull();
});

it('expands the done stack on desktop hover', async () => {
  width(false);
  await render('waiting');
  await act(async () =>
    container
      .querySelector('#stage-done')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
  );
  expect(container.querySelector('#stage-done .done-stack')!.classList.contains('expanded')).toBe(
    true,
  );
});

it('expands the done stack on keyboard focus', async () => {
  width(false);
  await render('waiting');
  await act(async () =>
    container
      .querySelector('#stage-done')!
      .dispatchEvent(new FocusEvent('focusin', { bubbles: true })),
  );
  expect(container.querySelector('#stage-done .done-stack')!.classList.contains('expanded')).toBe(
    true,
  );
});

it('toggles the phone done stack on tap', async () => {
  width(true);
  await render('done');
  await act(async () => container.querySelector<HTMLButtonElement>('.done-stack-toggle')!.click());
  expect(container.querySelector('.done-stack-toggle')!.getAttribute('aria-expanded')).toBe('true');
});

it('toggles a tiled header off on its second click', async () => {
  width(false);
  await render('waiting');
  const button = container.querySelector<HTMLButtonElement>('#stage-attention h2 button')!;
  await act(async () => button.click());
  await act(async () => button.click());
  expect(button.getAttribute('aria-pressed')).toBe('false');
});
