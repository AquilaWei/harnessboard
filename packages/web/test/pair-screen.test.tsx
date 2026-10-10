// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PairScreen } from '../src/components/PairScreen';
import '../src/i18n';

const mocks = vi.hoisted(() => ({
  pair: vi.fn(),
  registerPasskey: vi.fn(),
}));
vi.mock('../src/api', () => ({ api: { pair: mocks.pair } }));
vi.mock('../src/notify', () => ({ resetNotifications: () => undefined }));
vi.mock('../src/passkey', () => ({
  passkeysAvailable: () => true,
  registerPasskey: mocks.registerPasskey,
  checkPasskey: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
const onPaired = vi.fn();

beforeEach(() => {
  vi.stubGlobal('navigator', {
    ...navigator,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 9) Chrome/126.0 Mobile Safari/537.36',
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mocks.pair.mockResolvedValue(undefined);
  mocks.registerPasskey.mockResolvedValue(undefined);
  act(() => root.render(<PairScreen code="abc" onPaired={onPaired} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const submit = () =>
  act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });

describe('PairScreen', () => {
  it('suggests the phone model as the device name and allows pairing at once', () => {
    expect(container.querySelector('input')!.value).toBe('Pixel 9');
    expect(container.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(false);
  });

  it('pairs under the suggested name, then creates the passkey, from one submit', async () => {
    await submit();
    expect(mocks.pair).toHaveBeenCalledWith({ code: 'abc', name: 'Pixel 9' });
    expect(mocks.registerPasskey).toHaveBeenCalledTimes(1);
    expect(onPaired).toHaveBeenCalledTimes(1);
  });

  it('retries only the passkey when it failed, because the code is used up', async () => {
    mocks.registerPasskey.mockRejectedValueOnce(new Error('cancelled'));
    await submit();
    await submit();
    expect(mocks.pair).toHaveBeenCalledTimes(1);
    expect(mocks.registerPasskey).toHaveBeenCalledTimes(2);
    expect(onPaired).toHaveBeenCalledTimes(1);
  });
});
