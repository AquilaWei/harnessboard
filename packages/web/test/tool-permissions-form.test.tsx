// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
// Tools are allowed by default; the forms offer only asking before dangerous ones.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, Settings } from '@harnessboard/shared';
import { NewTaskDialog } from '../src/components/NewTaskDialog';
import { SettingsDialog } from '../src/components/SettingsDialog';
import '../src/i18n';

const api = vi.hoisted(() => ({
  agents: vi.fn(),
  agentModels: vi.fn(),
  createTask: vi.fn(),
  folders: vi.fn(),
  inspectFolder: vi.fn(),
  detectAgents: vi.fn(),
  pairingSetup: vi.fn(),
  devices: vi.fn(),
  saveSettings: vi.fn(),
}));
vi.mock('../src/api', () => ({ api }));
// happy-dom has no canvas; the QR image's content does not matter here.
vi.mock('qrcode', () => ({ default: { toDataURL: () => Promise.resolve('data:image/png;qr') } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings = {
  tokenSpike: { enabled: true, windowSeconds: 60, maxTokens: 100_000 },
  maxConcurrent: 1,
  quotaPauseUtilization: 0.9,
  quotaPauseByProvider: {},
  defaultContextPolicy: { size: 'medium' },
  defaultReviewer: null,
  allowedTools: ['Bash(make *)'],
  reviewGuidelines: [],
  remoteHosts: [],
  androidAppFingerprints: [],
} as unknown as Settings;

const profile = { provider: 'claude-code', command: 'claude', model: null };
const agents: AgentInfo[] = [
  { id: 'claude', profile, ok: true, version: '1', error: null },
] as AgentInfo[];

const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  api.agents.mockResolvedValue(agents);
  api.agentModels.mockResolvedValue([]);
  api.createTask.mockResolvedValue({ id: 7 });
  api.detectAgents.mockResolvedValue([]);
  api.pairingSetup.mockResolvedValue({
    tailscaleHost: null,
    tailscale: 'missing',
    canStartTailscale: false,
  });
  api.devices.mockResolvedValue([]);
  api.saveSettings.mockResolvedValue(settings);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

describe('NewTaskDialog tool permissions', () => {
  const openDialog = async () => {
    await act(async () =>
      root.render(<NewTaskDialog settings={settings} onClose={() => {}} onCreated={() => {}} />),
    );
  };

  /** The fieldset under the "Tool permissions" legend. */
  const permissions = () =>
    [...container.querySelectorAll('fieldset')].find(
      (set) => set.querySelector('legend')?.textContent === 'Tool permissions',
    )!;

  it('offers a single choice', async () => {
    await openDialog();
    expect(permissions().querySelectorAll('input')).toHaveLength(1);
  });

  it('lets the user ask before dangerous tools only', async () => {
    await openDialog();
    expect(permissions().querySelector('label')!.textContent).toContain(
      'Allow other tools, ask only for dangerous ones',
    );
  });

  it('has no field for tool rules', async () => {
    await openDialog();
    expect(permissions().querySelector('textarea')).toBeNull();
  });

  it('sends no tool rules with the task', async () => {
    await openDialog();
    act(() => type(container.querySelector('textarea')!, 'Add a settings page'));
    act(() => type(container.querySelector<HTMLInputElement>('.input-row input')!, '/repo'));
    await act(async () => container.querySelector('form')!.requestSubmit());
    expect(api.createTask.mock.calls[0]![0]).not.toHaveProperty('allowedTools');
  });
});

describe('SettingsDialog tool rules', () => {
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

  it('has no field for the tools every task may use', async () => {
    await open();
    expect([...container.querySelectorAll('textarea')].map((area) => area.value)).not.toContain(
      'Bash(make *)',
    );
  });

  it('keeps the saved tool rules when the settings are saved', async () => {
    await open();
    await act(async () => container.querySelector('form')!.requestSubmit());
    expect(api.saveSettings.mock.calls[0]![0]).not.toHaveProperty('allowedTools');
  });
});
