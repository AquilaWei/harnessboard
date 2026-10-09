// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
// A profile's default reasoning effort in the settings dialog.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, ModelInfo, Settings } from '@harnessboard/shared';
import { SettingsDialog } from '../src/components/SettingsDialog';
import '../src/i18n';

const api = vi.hoisted(() => ({
  agents: vi.fn(),
  agentModels: vi.fn(),
  setAgentEffort: vi.fn(),
  detectAgents: vi.fn(),
  pairingSetup: vi.fn(),
  devices: vi.fn(),
  createPairing: vi.fn(),
  saveSettings: vi.fn(),
}));
vi.mock('../src/api', () => ({ api }));
// happy-dom has no canvas; the QR image's content does not matter here.
vi.mock('qrcode', () => ({ default: { toDataURL: () => Promise.resolve('data:image/png;qr') } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings = {
  maxConcurrent: 1,
  quotaPauseUtilization: 0.95,
  defaultContextPolicy: { size: 'medium' },
  defaultReviewer: null,
  allowedTools: [],
  reviewGuidelines: [],
  remoteHosts: [],
  androidAppFingerprints: [],
} as unknown as Settings;

const agent = (id: string, model: string | null, effort?: string): AgentInfo => ({
  id,
  profile: { provider: 'codex', command: 'codex', model, ...(effort ? { effort } : {}) },
  ok: true,
  version: '1',
  error: null,
});

const SOL: ModelInfo = {
  id: 'gpt-6-sol',
  name: 'gpt-6-sol',
  description: null,
  note: null,
  more: false,
  efforts: [
    { id: 'low', name: 'low', description: null, note: null },
    { id: 'medium', name: 'medium', description: null, note: null },
    { id: 'high', name: 'high', description: null, note: null },
  ],
  defaultEffort: 'medium',
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  api.agentModels.mockResolvedValue([SOL]);
  api.setAgentEffort.mockResolvedValue({});
  api.detectAgents.mockResolvedValue([]);
  api.pairingSetup.mockResolvedValue({ tailscaleHost: null, port: 4317 });
  api.devices.mockResolvedValue([]);
  api.saveSettings.mockResolvedValue(settings);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

const open = async () =>
  act(async () =>
    root.render(
      <SettingsDialog
        settings={settings}
        configFile={null}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    ),
  );

const effortSelect = () =>
  container.querySelector<HTMLSelectElement>('select[aria-label="Reasoning effort"]');

const choose = (select: HTMLSelectElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
};

const submit = async () => {
  await act(async () => container.querySelector('form')!.requestSubmit());
};

describe('Settings: profile reasoning effort', () => {
  it("offers the efforts of the profile's model, with the CLI's default first", async () => {
    api.agents.mockResolvedValue([agent('codex', 'gpt-6-sol')]);
    await open();
    expect([...effortSelect()!.options].map((o) => o.textContent)).toEqual([
      'Default (Medium)',
      'Low',
      'Medium',
      'High',
    ]);
  });

  it('shows the stored effort as chosen', async () => {
    api.agents.mockResolvedValue([agent('codex', 'gpt-6-sol', 'high')]);
    await open();
    expect(effortSelect()!.value).toBe('high');
  });

  it('saves a chosen effort for the profile', async () => {
    api.agents.mockResolvedValue([agent('codex', 'gpt-6-sol')]);
    await open();
    act(() => choose(effortSelect()!, 'high'));
    await submit();
    expect(api.setAgentEffort.mock.calls).toEqual([['codex', 'high']]);
  });

  it('removes the effort when Default is chosen', async () => {
    api.agents.mockResolvedValue([agent('codex', 'gpt-6-sol', 'high')]);
    await open();
    act(() => choose(effortSelect()!, ''));
    await submit();
    expect(api.setAgentEffort.mock.calls).toEqual([['codex', null]]);
  });

  it('saves no effort when none was changed', async () => {
    api.agents.mockResolvedValue([agent('codex', 'gpt-6-sol', 'high')]);
    await open();
    await submit();
    expect(api.setAgentEffort).not.toHaveBeenCalled();
  });

  it('shows a stored effort the model does not offer as chosen', async () => {
    api.agents.mockResolvedValue([agent('codex', 'gpt-6-sol', 'max')]);
    await open();
    const select = effortSelect()!;
    expect(select.selectedOptions[0]!.textContent).toBe('Max (not offered by this model)');
  });

  it('removes a stored effort the model does not offer when Default is chosen', async () => {
    api.agents.mockResolvedValue([agent('codex', 'gpt-6-sol', 'max')]);
    await open();
    // A browser fires no change when Default is already the selected option.
    expect(effortSelect()!.value).toBe('max');
    act(() => choose(effortSelect()!, ''));
    await submit();
    expect(api.setAgentEffort.mock.calls).toEqual([['codex', null]]);
  });

  it('offers no choice for a profile without a model', async () => {
    api.agents.mockResolvedValue([agent('codex', null)]);
    await open();
    expect(effortSelect()).toBeNull();
  });
});
