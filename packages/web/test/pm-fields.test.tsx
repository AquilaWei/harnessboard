// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { AgentInfo, PmConfig } from '@harnessboard/shared';
import { PmFields } from '../src/components/PmFields';
import '../src/i18n';

vi.mock('../src/api', () => ({
  api: {
    agentModels: vi
      .fn()
      .mockResolvedValue([{ id: 'worker-model', name: 'Worker Model', efforts: [], more: false }]),
  },
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const agents: AgentInfo[] = [
  {
    id: 'codex',
    profile: { provider: 'codex', command: 'codex', model: null },
    ok: true,
    version: '1',
    error: null,
  },
];

it('adds a catalog model to the worker pool and removes it independently', async () => {
  const changed = vi.fn();
  function Form() {
    const [value, setValue] = useState<PmConfig>({
      agentId: 'codex',
      model: null,
      effort: null,
      workers: [{ agentId: 'codex', models: [null] }],
    });
    return (
      <PmFields
        agents={agents}
        value={value}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Form />));
    const select = container.querySelector<HTMLSelectElement>('fieldset select')!;
    await act(async () => {
      select.value = 'worker-model';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const add = container.querySelector<HTMLButtonElement>('fieldset > div > div > button')!;
    await act(async () => add.click());
    expect(changed.mock.lastCall![0].workers).toEqual([
      { agentId: 'codex', models: [null, 'worker-model'] },
    ]);
    expect(add.disabled).toBe(true);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Remove worker-model"]')!
        .click(),
    );
    expect(changed.mock.lastCall![0].workers).toEqual([{ agentId: 'codex', models: [null] }]);
  } finally {
    act(() => root.unmount());
  }
});
