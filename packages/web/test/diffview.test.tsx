// SPDX-License-Identifier: Apache-2.0
// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiffView, diffFiles } from '../src/components/DiffView';
import '../src/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const text = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1 @@',
  '-old line',
  '+new line',
].join('\n');

describe('diffFiles', () => {
  it('lists each file a diff touches', () => {
    const two = `${text}\ndiff --git a/README.md b/README.md\n@@ -1 +1 @@`;
    expect(diffFiles(two)).toEqual(['src/app.ts', 'README.md']);
  });

  it('gives the new path of a renamed file', () => {
    expect(diffFiles('diff --git a/old name.ts b/new name.ts')).toEqual(['new name.ts']);
  });
});

describe('DiffView', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<DiffView diff={{ diff: text, untracked: [] }} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const filesOnly = () =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === 'Files only')!;

  it('shows the hunks until Files only is pressed', () => {
    expect(container.querySelector('pre.diff')?.textContent).toContain('+new line');
  });

  it('hides the hunks and lists the changed files when Files only is pressed', async () => {
    await act(async () => filesOnly().click());
    expect(container.querySelector('pre.diff')).toBeNull();
    expect(container.querySelector('.diff-files')?.textContent).toBe('src/app.ts');
  });

  it('shows the hunks again when Files only is pressed a second time', async () => {
    await act(async () => filesOnly().click());
    await act(async () => filesOnly().click());
    expect(container.querySelector('pre.diff')?.textContent).toContain('+new line');
  });
});
