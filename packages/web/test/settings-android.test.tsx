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
  saveSettings: vi.fn(),
}));
vi.mock('../src/api', () => ({ api }));
// happy-dom has no canvas; the QR image's content does not matter here.
vi.mock('qrcode', () => ({ default: { toDataURL: () => Promise.resolve('data:image/png;qr') } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FINGERPRINT =
  'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';

const settings = {
  maxConcurrent: 2,
  quotaPauseUtilization: 0.9,
  defaultContextPolicy: { size: 'medium' },
  defaultReviewer: null,
  allowedTools: [],
  reviewGuidelines: [],
  remoteHosts: ['pc.tailnet.ts.net'],
  androidAppFingerprints: [FINGERPRINT],
} as unknown as Settings;

const type = (field: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
};

let root: Root;
let container: HTMLElement;
let closed: boolean;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  closed = false;
  api.agents.mockResolvedValue([]);
  api.detectAgents.mockResolvedValue([]);
  api.pairingSetup.mockResolvedValue({ tailscaleHost: null, port: 4317 });
  api.devices.mockResolvedValue([]);
  api.createPairing.mockResolvedValue({ code: 'abc', expiresAt: 0 });
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
        onClose={() => (closed = true)}
        onSaved={() => (closed = true)}
      />,
    ),
  );

const appBlock = () => container.querySelector('.android-app')!;

const fingerprintField = () => appBlock().querySelector('textarea')!;

const submit = async () => {
  await act(async () => container.querySelector('form')!.requestSubmit());
};

describe('Settings: Android app block', () => {
  it('names the app block and says what the app is', async () => {
    await open();
    expect(appBlock().querySelector('h4')!.textContent).toBe('Android app');
    expect(appBlock().querySelector('p')!.textContent).toContain(
      'The Android app opens this same board in its own window, without a URL bar.',
    );
  });

  it('links to the GitHub releases page', async () => {
    await open();
    expect(appBlock().querySelector('a')!.getAttribute('href')).toBe(
      'https://github.com/AquilaWei/harnessboard/releases',
    );
  });

  it('shows the saved fingerprints, one per line', async () => {
    await open();
    expect(fingerprintField().value).toBe(FINGERPRINT);
  });

  it('saves the fingerprints trimmed and without blank lines', async () => {
    api.saveSettings.mockResolvedValue(settings);
    await open();
    act(() => type(fingerprintField(), `  ${FINGERPRINT}  \n\n`));
    await submit();
    expect(api.saveSettings.mock.calls[0]![0]).toMatchObject({
      androidAppFingerprints: [FINGERPRINT],
    });
  });

  it('shows the server error for an invalid fingerprint and keeps the dialog open', async () => {
    api.saveSettings.mockRejectedValue(
      new Error(
        'config androidAppFingerprints must be a list of SHA-256 fingerprints (32 hex bytes separated by colons)',
      ),
    );
    await open();
    act(() => type(fingerprintField(), 'AB:CD'));
    await submit();
    expect(container.querySelector('.error')!.textContent).toBe(
      'config androidAppFingerprints must be a list of SHA-256 fingerprints (32 hex bytes separated by colons)',
    );
    expect(closed).toBe(false);
  });

  it('shows one pairing QR code for both the browser and the app', async () => {
    await open();
    const pair = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Pair a phone',
    )!;
    await act(async () => pair.click());
    expect(container.querySelectorAll('img').length).toBe(1);
  });
});
