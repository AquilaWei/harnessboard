// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_INLINE_LIMIT, parseVerdict, reviewEvidence } from '../src/review.js';
import { makeRepo, tempDir } from './helpers.js';

describe('parseVerdict', () => {
  it('reads an approval and keeps the rest as findings', () => {
    expect(parseVerdict('VERDICT: APPROVE\nLooks right.')).toEqual({
      verdict: 'approve',
      findings: 'Looks right.',
    });
  });

  it('reads a change request', () => {
    expect(parseVerdict('VERDICT: CHANGES\n- add a test').verdict).toBe('changes');
  });

  it('accepts a lower-case verdict line after blank lines', () => {
    expect(parseVerdict('\n  verdict: approve').verdict).toBe('approve');
  });

  it('returns no verdict when the first line has none, keeping the whole reply', () => {
    expect(parseVerdict('I think it is fine.\nVERDICT: APPROVE')).toEqual({
      verdict: null,
      findings: 'I think it is fine.\nVERDICT: APPROVE',
    });
  });
});

describe('reviewEvidence', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

  /** A repository with one commit after `init` that adds `file`; returns it and `init`. */
  function repoWithCommit(file: string, content: string): { repo: string; since: string } {
    const repo = makeRepo();
    const since = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(path.join(repo, file), content);
    git(repo, 'add', file);
    git(repo, 'commit', '-q', '-m', `add ${file}`);
    return { repo, since };
  }

  /** Deletes `README.md` (its line is `hello`) in a commit of its own. */
  function deleteReadme(repo: string): void {
    git(repo, 'rm', '-q', 'README.md');
    git(repo, 'commit', '-q', '-m', 'delete README.md');
  }

  it('includes the edits not yet committed', async () => {
    const { repo, since } = repoWithCommit('a.txt', 'a\n');
    writeFileSync(path.join(repo, 'README.md'), 'hello\nnot committed\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    const evidence = await reviewEvidence(
      repo,
      { round: 1, since, head, status: '' },
      tempDir('ev'),
    );
    expect(evidence).toContain('+not committed');
  });

  it('leaves out the uncommitted section when there is nothing uncommitted', async () => {
    const { repo, since } = repoWithCommit('a.txt', 'a\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    const evidence = await reviewEvidence(
      repo,
      { round: 1, since, head, status: '' },
      tempDir('ev'),
    );
    expect(evidence).not.toContain('$ git diff HEAD');
  });

  it('keeps the prompt within the quoted limit when the patch is larger', async () => {
    const { repo, since } = repoWithCommit('big.txt', 'x'.repeat(EVIDENCE_INLINE_LIMIT * 2));
    const head = git(repo, 'rev-parse', 'HEAD');
    const evidence = await reviewEvidence(
      repo,
      { round: 1, since, head, status: '' },
      tempDir('ev'),
    );
    expect(evidence.length).toBeLessThan(EVIDENCE_INLINE_LIMIT + 3_000);
  });

  it('names the file holding a patch too long to quote', async () => {
    const { repo, since } = repoWithCommit('big.txt', 'x'.repeat(EVIDENCE_INLINE_LIMIT * 2));
    const head = git(repo, 'rev-parse', 'HEAD');
    const out = tempDir('ev');
    const evidence = await reviewEvidence(repo, { round: 1, since, head, status: '' }, out);
    expect(evidence).toContain(`read all of \`${path.join(out, 'current-diff.txt')}\``);
  });

  it('keeps a deletion past the quoted limit in the patch file', async () => {
    const { repo, since } = repoWithCommit('big.txt', 'x'.repeat(EVIDENCE_INLINE_LIMIT * 2));
    deleteReadme(repo);
    const head = git(repo, 'rev-parse', 'HEAD');
    const out = tempDir('ev');
    await reviewEvidence(repo, { round: 1, since, head, status: '' }, out);
    const patch = readFileSync(path.join(out, 'current-diff.txt'), 'utf8');
    expect(patch).toContain(
      'deleted file mode 100644\nindex ce01362..0000000\n--- a/README.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-hello\n',
    );
  });

  it('keeps an earlier stretch in its own file after the quoted limit is used up', async () => {
    const repo = makeRepo();
    const from = git(repo, 'rev-parse', 'HEAD');
    deleteReadme(repo);
    const to = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(EVIDENCE_INLINE_LIMIT * 2));
    git(repo, 'add', 'big.txt');
    git(repo, 'commit', '-q', '-m', 'add big.txt');
    const head = git(repo, 'rev-parse', 'HEAD');
    const out = tempDir('ev');
    await reviewEvidence(
      repo,
      { round: 1, since: to, head, status: '', earlier: [{ from, to }] },
      out,
    );
    const patch = readFileSync(path.join(out, 'earlier-1-diff.txt'), 'utf8');
    expect(patch).toContain('--- a/README.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-hello\n');
  });

  it('removes the files of an earlier review', async () => {
    const { repo, since } = repoWithCommit('a.txt', 'a\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    const out = tempDir('ev');
    writeFileSync(path.join(out, 'earlier-1-diff.txt'), 'stale');
    await reviewEvidence(repo, { round: 1, since, head, status: '' }, out);
    expect(existsSync(path.join(out, 'earlier-1-diff.txt'))).toBe(false);
  });
});
