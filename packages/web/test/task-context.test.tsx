// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { TaskDetail } from '@harnessboard/shared';
import { TaskContextEditor } from '../src/components/TaskContextEditor';
import '../src/i18n';

const api = vi.hoisted(() => ({ setTaskContext: vi.fn().mockResolvedValue({}) }));
vi.mock('../src/api', () => ({ api }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('saves an edited budget for a running task without starting it again', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const onSaved = vi.fn();
  const onError = vi.fn();
  const task = { id: 23, status: 'running', contextPolicy: { size: 'small' } } as TaskDetail;
  try {
    await act(async () =>
      root.render(<TaskContextEditor task={task} onSaved={onSaved} onError={onError} />),
    );
    const input = container.querySelectorAll('input')[1]!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '75');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(api.setTaskContext).toHaveBeenCalledWith(23, {
      size: 'small',
      softPct: 30,
      hardPct: 75,
      compactPct: 30,
    });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
