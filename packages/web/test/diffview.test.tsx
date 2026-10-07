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
    const rename = [
      'diff --git a/old name.ts b/new name.ts',
      'similarity index 100%',
      'rename from old name.ts',
      'rename to new name.ts',
    ].join('\n');
    expect(diffFiles(rename)).toEqual(['new name.ts']);
  });

  it('gives the decoded new path of a rename between quoted Chinese names', () => {
    const rename = [
      'diff --git "a/\\350\\210\\212.md" "b/\\346\\226\\260.md"',
      'similarity index 100%',
      'rename from "\\350\\210\\212.md"',
      'rename to "\\346\\226\\260.md"',
    ].join('\n');
    expect(diffFiles(rename)).toEqual(['新.md']);
  });

  it('decodes a quoted Chinese path', () => {
    const quoted = [
      'diff --git "a/\\344\\270\\255\\346\\226\\207.txt" "b/\\344\\270\\255\\346\\226\\207.txt"',
      '--- "a/\\344\\270\\255\\346\\226\\207.txt"',
      '+++ "b/\\344\\270\\255\\346\\226\\207.txt"',
      '@@ -1 +1 @@',
    ].join('\n');
    expect(diffFiles(quoted)).toEqual(['中文.txt']);
  });

  it('decodes a quoted path with a tab', () => {
    const quoted = [
      'diff --git "a/tab\\there.txt" "b/tab\\there.txt"',
      '--- "a/tab\\there.txt"',
      '+++ "b/tab\\there.txt"',
      '@@ -1 +1 @@',
    ].join('\n');
    expect(diffFiles(quoted)).toEqual(['tab\there.txt']);
  });

  it('decodes a quoted path with quotes and the tab git adds after a space', () => {
    const quoted = [
      'diff --git "a/say \\"hi\\".txt" "b/say \\"hi\\".txt"',
      '--- "a/say \\"hi\\".txt"\t',
      '+++ "b/say \\"hi\\".txt"\t',
      '@@ -1 +1 @@',
    ].join('\n');
    expect(diffFiles(quoted)).toEqual(['say "hi".txt']);
  });

  it('gives the path of a deleted file', () => {
    const deleted = [
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
    ].join('\n');
    expect(diffFiles(deleted)).toEqual(['gone.txt']);
  });

  it('gives the decoded path of a binary file from its quoted header', () => {
    const binary = [
      'diff --git "a/bin \\346\\252\\224.dat" "b/bin \\346\\252\\224.dat"',
      'new file mode 100644',
      'Binary files /dev/null and "b/bin \\346\\252\\224.dat" differ',
    ].join('\n');
    expect(diffFiles(binary)).toEqual(['bin 檔.dat']);
  });

  it('gives the whole path of an unquoted file whose name contains " b/"', () => {
    const header = 'diff --git a/x b/y.txt b/x b/y.txt\nold mode 100644\nnew mode 100755';
    expect(diffFiles(header)).toEqual(['x b/y.txt']);
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
