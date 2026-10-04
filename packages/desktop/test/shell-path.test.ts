// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loginShellPath, mergePaths, pathFromShellOutput } from '../src/shell-path.js';

describe('pathFromShellOutput', () => {
  it('reads the PATH between the marks', () => {
    expect(
      pathFromShellOutput('__HARNESSBOARD_PATH__/usr/bin:/home/a/.local/bin__HARNESSBOARD_PATH__'),
    ).toBe('/usr/bin:/home/a/.local/bin');
  });

  it('ignores text a startup file prints around it', () => {
    expect(
      pathFromShellOutput('Welcome!\n__HARNESSBOARD_PATH__/usr/bin__HARNESSBOARD_PATH__\nbye'),
    ).toBe('/usr/bin');
  });

  it('is null without the marks', () => {
    expect(pathFromShellOutput('/usr/bin')).toBeNull();
  });

  it('is null for an empty PATH', () => {
    expect(pathFromShellOutput('__HARNESSBOARD_PATH____HARNESSBOARD_PATH__')).toBeNull();
  });
});

describe('mergePaths', () => {
  it("puts the shell's entries first", () => {
    expect(mergePaths('/home/a/.local/bin:/usr/bin', '/usr/bin:/bin', ':')).toBe(
      '/home/a/.local/bin:/usr/bin:/bin',
    );
  });

  it('drops empty entries', () => {
    expect(mergePaths('/usr/bin::', ':/bin', ':')).toBe('/usr/bin:/bin');
  });
});

/** A stand-in shell that prints `output` whatever it is asked to run. */
function fakeShell(output: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'hb-shell-')), 'shell');
  writeFileSync(file, `#!/bin/sh\nprintf '%s' '${output}'\n`);
  chmodSync(file, 0o755);
  return file;
}

describe.runIf(process.platform !== 'win32')('loginShellPath', () => {
  it('reads the PATH the shell prints', async () => {
    const shell = fakeShell('motd\n__HARNESSBOARD_PATH__/opt/bin:/usr/bin__HARNESSBOARD_PATH__');
    expect(await loginShellPath(shell, 5000)).toBe('/opt/bin:/usr/bin');
  });

  it('is null when the shell can not run', async () => {
    expect(await loginShellPath('/no/such/shell', 5000)).toBeNull();
  });
});
