// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_PATCH_LIMIT, parseVerdict, reviewEvidence } from '../src/review.js';
import { makeRepo } from './helpers.js';

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

  it('includes the edits not yet committed', async () => {
    const { repo, since } = repoWithCommit('a.txt', 'a\n');
    writeFileSync(path.join(repo, 'README.md'), 'hello\nnot committed\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    const evidence = await reviewEvidence(repo, { round: 1, since, head, status: '' });
    expect(evidence).toContain('+not committed');
  });

  it('leaves out the uncommitted section when there is nothing uncommitted', async () => {
    const { repo, since } = repoWithCommit('a.txt', 'a\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    const evidence = await reviewEvidence(repo, { round: 1, since, head, status: '' });
    expect(evidence).not.toContain('$ git diff HEAD');
  });

  it('cuts a patch over the limit and says where to look instead', async () => {
    const { repo, since } = repoWithCommit('big.txt', 'x'.repeat(EVIDENCE_PATCH_LIMIT * 2));
    const head = git(repo, 'rev-parse', 'HEAD');
    const evidence = await reviewEvidence(repo, { round: 1, since, head, status: '' });
    expect([
      evidence.length < EVIDENCE_PATCH_LIMIT + 2_000,
      evidence.includes('The patch was cut here'),
      evidence.includes('big.txt | 1 +'),
    ]).toEqual([true, true, true]);
  });
});
