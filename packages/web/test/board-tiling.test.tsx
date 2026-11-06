// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { TaskView } from '@harnessboard/shared';
import type { Stage } from '../src/board';
import { Board } from '../src/components/Board';
import '../src/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card = (id: number, status: TaskView['status']) =>
  ({
    id,
    title: 'Task',
    status,
    mode: 'single',
    agents: { implementer: 'claude', reviewer: null, maxReviewRounds: 2 },
    activity: null,
    context: null,
    loop: null,
    permissionRequests: [],
  }) as unknown as TaskView;

let root: Root;
let container: HTMLElement;
const onTile = vi.fn();

async function render(tiledStage: Stage | null = null) {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <Board
        tasks={[card(11, 'running'), card(12, 'queued'), card(13, 'done')]}
        phoneTab="waiting"
        tiledStage={tiledStage}
        onTile={onTile}
        onPhoneTab={() => {}}
        onOpen={() => {}}
        onAction={() => {}}
        onInvalidMove={() => {}}
        onNewTask={() => {}}
      />,
    ),
  );
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('calls onTile with the active stage and all its task ids', async () => {
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('#stage-active h2 button')!.click(),
  );
  expect(onTile).toHaveBeenCalledWith('active', [12, 11]);
});

it('renders no button in the draft or done header', async () => {
  await render();
  expect(container.querySelector('#stage-draft h2 button, #stage-done h2 button')).toBeNull();
});

it('marks the matching tiled header as pressed', async () => {
  await render('active');
  expect(container.querySelector('#stage-active h2 button')!.getAttribute('aria-pressed')).toBe(
    'true',
  );
});

it('expands the desktop done stack on mouse enter', async () => {
  await render();
  await act(async () =>
    container
      .querySelector('#stage-done')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
  );
  expect(container.querySelector('#stage-done .done-stack')!.classList.contains('expanded')).toBe(
    true,
  );
});

it('collapses the desktop done stack on mouse leave', async () => {
  await render();
  const stage = container.querySelector('#stage-done')!;
  await act(async () => stage.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  await act(async () =>
    stage.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }),
    ),
  );
  expect(container.querySelector('#stage-done .done-stack')!.classList.contains('expanded')).toBe(
    false,
  );
});

it('expands the desktop done stack on focus inside a card', async () => {
  await render();
  await act(async () =>
    container
      .querySelector('#stage-done .done-stack button')!
      .dispatchEvent(new FocusEvent('focusin', { bubbles: true })),
  );
  expect(container.querySelector('#stage-done .done-stack')!.classList.contains('expanded')).toBe(
    true,
  );
});

it('ignores the header of an empty stage', async () => {
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('#stage-pending h2 button')!.click(),
  );
  expect(onTile).not.toHaveBeenCalled();
});

it('gives the desktop done stack an accessible group role', async () => {
  await render();
  expect(container.querySelector('#stage-done .done-stack')!.getAttribute('role')).toBe('group');
});
