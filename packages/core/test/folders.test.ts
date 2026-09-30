// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome, inspectFolder, listFolders, resolveRepository } from '../src/folders.js';
import { makeRepo, tempDir } from './helpers.js';

const emptyRepo = () => {
  const dir = tempDir('empty');
  execFileSync('git', ['init', '-q', dir]);
  return dir;
};

describe('expandHome', () => {
  it('expands a leading ~/', () => {
    expect(expandHome('~/code')).toBe(path.join(os.homedir(), 'code'));
  });

  it('leaves other paths alone', () => {
    expect(expandHome('/srv/~x')).toBe('/srv/~x');
  });
});

describe('inspectFolder', () => {
  it('reports a missing folder', async () => {
    const missing = path.join(tempDir('x'), 'nope');
    expect((await inspectFolder(missing)).exists).toBe(false);
  });

  it('finds the repository root from a subfolder', async () => {
    const repo = makeRepo();
    mkdirSync(path.join(repo, 'src'));
    expect((await inspectFolder(path.join(repo, 'src'))).repoRoot).toBe(repo);
  });

  it('reports a repository without commits', async () => {
    const info = await inspectFolder(emptyRepo());
    expect([info.repoRoot !== null, info.hasCommits]).toEqual([true, false]);
  });
});

describe('resolveRepository', () => {
  it('explains a folder outside any repository', async () => {
    await expect(resolveRepository(tempDir('plain'))).rejects.toThrow(
      /is not inside a git repository\. Run "git init"/,
    );
  });

  it('explains a repository without commits', async () => {
    await expect(resolveRepository(emptyRepo())).rejects.toThrow(/has no commits yet/);
  });

  it('explains a missing folder', async () => {
    await expect(resolveRepository(path.join(tempDir('x'), 'nope'))).rejects.toThrow(
      /folder not found/,
    );
  });
});

describe('listFolders', () => {
  it('lists visible subfolders by name and marks repositories', async () => {
    const dir = tempDir('list');
    mkdirSync(path.join(dir, 'b-plain'));
    mkdirSync(path.join(dir, '.hidden'));
    execFileSync('git', ['init', '-q', path.join(dir, 'a-repo')]);
    const listing = await listFolders(dir);
    expect(listing.entries.map((e) => [e.name, e.isRepo])).toEqual([
      ['a-repo', true],
      ['b-plain', false],
    ]);
  });

  it('gives the parent folder', async () => {
    const dir = tempDir('list');
    expect((await listFolders(dir)).parent).toBe(path.dirname(dir));
  });

  it('starts at the home folder when no path is given', async () => {
    expect((await listFolders()).path).toBe(os.homedir());
  });
});
