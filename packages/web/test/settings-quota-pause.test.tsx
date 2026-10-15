// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
// Each platform's quota pause level in the settings dialog.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@harnessboard/shared';
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
  tokenSpike: { enabled: true, windowSeconds: 60, maxTokens: 100_000 },
  maxConcurrent: 1,
  quotaPauseUtilization: 0.9,
  quotaPauseByProvider: { codex: 0.8 },
  defaultContextPolicy: { size: 'medium' },
  defaultReviewer: null,
  allowedTools: [],
  reviewGuidelines: [],
  remoteHosts: [],
  androidAppFingerprints: [],
} as unknown as Settings;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  api.agents.mockResolvedValue([]);
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

/** The pause level field of the platform shown as `name`. */
const pauseField = (name: string) =>
  [...container.querySelectorAll('label')]
    .find((label) => label.textContent === `Pause ${name} work at 5-hour quota %`)!
    .querySelector('input')!;

const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const submit = async () => {
  await act(async () => container.querySelector('form')!.requestSubmit());
};

describe('Settings: quota pause level per platform', () => {
  it("shows a platform's own level", async () => {
    await open();
    expect(pauseField('Codex').value).toBe('80');
  });

  it('shows the shared level for a platform without its own', async () => {
    await open();
    expect(pauseField('Claude').value).toBe('90');
  });

  it('saves a level for each platform', async () => {
    await open();
    act(() => type(pauseField('Codex'), '70'));
    await submit();
    expect(api.saveSettings.mock.calls[0]![0].quotaPauseByProvider).toEqual({
      'claude-code': 0.9,
      codex: 0.7,
    });
  });
});
