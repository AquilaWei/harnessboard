// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@harnessboard/shared';
import { SettingsDialog } from '../src/components/SettingsDialog';
import '../src/i18n';

const api = vi.hoisted(() => ({
  agents: vi.fn(),
  detectAgents: vi.fn(),
  pairingSetup: vi.fn(),
  devices: vi.fn(),
  createPairing: vi.fn(),
  revokeDevice: vi.fn(),
  saveSettings: vi.fn(),
}));
vi.mock('../src/api', () => ({ api }));
// happy-dom has no canvas; the QR image's content does not matter here.
vi.mock('qrcode', () => ({ default: { toDataURL: () => Promise.resolve('data:image/png;qr') } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings = {
  maxConcurrent: 2,
  quotaPauseUtilization: 0.9,
  defaultContextPolicy: { size: 'medium' },
  defaultReviewer: null,
  allowedTools: [],
  reviewGuidelines: [],
  remoteHosts: ['pc.tailnet.ts.net'],
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
  api.pairingSetup.mockResolvedValue({ tailscaleHost: 'pc.tailnet.ts.net' });
  api.devices.mockResolvedValue([]);
  api.createPairing.mockResolvedValue({ code: 'abc', expiresAt: 0, host: 'pc.tailnet.ts.net' });
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

const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;

describe('Settings: phone access', () => {
  it('shows no field for remote hosts', async () => {
    await open();
    expect(container.textContent).not.toContain('Remote hosts');
  });

  it('shows no tailscale serve command', async () => {
    await open();
    expect(container.textContent).not.toContain('tailscale serve');
  });

  it('shows no Android app block', async () => {
    await open();
    expect(container.querySelector('.android-app')).toBeNull();
  });

  it('shows the pairing QR code after Pair a phone', async () => {
    await open();
    await act(async () => button('Pair a phone').click());
    expect(container.querySelectorAll('img').length).toBe(1);
  });

  it('puts the host the server returned in the pairing address', async () => {
    await open();
    await act(async () => button('Pair a phone').click());
    expect(container.querySelector('.pairing .mono')!.textContent).toBe(
      'https://pc.tailnet.ts.net/#pair=abc',
    );
  });

  it('disables pairing and says why when Tailscale is not found', async () => {
    api.pairingSetup.mockResolvedValue({ tailscaleHost: null });
    await open();
    expect([button('Pair a phone').disabled, container.textContent]).toEqual([
      true,
      expect.stringContaining('Tailscale was not found'),
    ]);
  });

  it('lists the paired devices', async () => {
    api.devices.mockResolvedValue([{ id: 1, name: 'My phone', lastSeenAt: 0 }]);
    await open();
    expect(container.querySelector('tbody td')!.textContent).toBe('My phone');
  });

  it('saves settings without touching remote hosts or fingerprints', async () => {
    api.saveSettings.mockResolvedValue(settings);
    await open();
    await act(async () => container.querySelector('form')!.requestSubmit());
    const sent = api.saveSettings.mock.calls[0]![0] as Record<string, unknown>;
    expect(['remoteHosts', 'androidAppFingerprints'].filter((k) => k in sent)).toEqual([]);
  });
});
