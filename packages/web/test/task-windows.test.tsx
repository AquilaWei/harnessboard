// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { TaskWindows } from '../src/components/TaskWindows';

it('renders every task with only the last window active', () => {
  const markup = renderToStaticMarkup(
    <TaskWindows
      windows={[
        { id: 1, tab: 'timeline' },
        { id: 2, tab: 'chat' },
        { id: 3, tab: 'log' },
      ]}
      onFocus={vi.fn()}
    >
      {(task, active) => <span data-active={active}>{task.id}</span>}
    </TaskWindows>,
  );
  expect(markup.match(/class="task-window"/g)).toHaveLength(3);
  expect(markup).toContain('data-active="false">1');
  expect(markup).toContain('data-active="true">3');
});
