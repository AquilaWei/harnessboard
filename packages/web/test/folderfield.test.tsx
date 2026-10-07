// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderField } from '../src/components/FolderField';
import '../src/i18n';

// The server's folder listing; each test says whether it answers, hangs or fails.
const api = vi.hoisted(() => ({ folders: vi.fn(), inspectFolder: vi.fn() }));
vi.mock('../src/api', () => ({ api }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('FolderField browser', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
  });

  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === label);

  const openBrowser = async () => {
    await act(async () => root.render(<FolderField value="" onChange={() => {}} recent={[]} />));
    await act(async () => button('Browse…')!.click());
  };

  const browser = () => container.querySelector('.folder-browser');
  /** The Close inside the browser, which is the only one reachable when it covers the phone screen. */
  const closeInBrowser = () =>
    [...browser()!.querySelectorAll('button')].find((b) => b.textContent === 'Close');

  it('closes from inside the browser while the folder list is still loading', async () => {
    api.folders.mockReturnValue(new Promise(() => {}));
    await openBrowser();
    await act(async () => closeInBrowser()!.click());
    expect(browser()).toBeNull();
  });

  it('closes from inside the browser after the folder list fails to load', async () => {
    api.folders.mockRejectedValue(new Error('permission denied'));
    await openBrowser();
    expect(browser()?.querySelector('.error')?.textContent).toBe('permission denied');
    await act(async () => closeInBrowser()!.click());
    expect(browser()).toBeNull();
  });
});
