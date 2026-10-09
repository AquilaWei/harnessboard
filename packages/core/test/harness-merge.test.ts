// SPDX-License-Identifier: Apache-2.0
// Merging a reviewed task's branch into its base, with real git repositories.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { FAKE_CLAUDE, init, makeRepo, result, tempDir, writeScenario } from './helpers.js';

interface FakeRun {
  args: string[];
  received: string[];
}

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('merge');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: { claude: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null } },
    fallbackContextWindow: 100_000,
  };
  harness = Harness.open(config);
});

afterEach(async () => {
  await harness.shutdown();
  harness.store.close();
});

function scenario(...sessions: unknown[][][]): void {
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, sessions);
}

function fakeRuns(): FakeRun[] {
  const file = process.env.FAKE_CLAUDE_LOG!;
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as FakeRun);
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** Writes and commits a file, as an agent (or the user on the base) would. */
function commitFile(cwd: string, file: string, content: string): void {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', file);
}

/** A single task whose session finished with a commit, waiting in review. */
async function reviewedTask(...later: unknown[][][]) {
  scenario([[init(), result('done')]], ...later);
  const task = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    confirmPlan: false,
    reviewer: null,
    queue: true,
  });
  await harness.waitForIdle();
  const worktree = harness.store.getTask(task.id)!.worktreePath!;
  commitFile(worktree, 'hello.txt', 'hi\n');
  return { task, worktree };
}

describe('merging a reviewed task', () => {
  it('adds a merge commit for the task to the base', async () => {
    const { task } = await reviewedTask();
    await harness.mergeTask(task.id);
    expect(git(repo, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2);
  });

  it('words the merge commit subject as a chore with the task number, not its title', async () => {
    const { task } = await reviewedTask();
    await harness.mergeTask(task.id);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('chore: merge task #1');
    expect(git(repo, 'log', '-1', '--format=%b')).toContain('Add a greeting');
  });

  it('updates the checked-out base so its files show the work', async () => {
    const { task } = await reviewedTask();
    await harness.mergeTask(task.id);
    expect(readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toBe('hi\n');
  });

  it('marks the task done', async () => {
    const { task } = await reviewedTask();
    await harness.mergeTask(task.id);
    expect(harness.store.getTask(task.id)!.status).toBe('done');
  });

  it('removes the worktree', async () => {
    const { task, worktree } = await reviewedTask();
    await harness.mergeTask(task.id);
    expect([existsSync(worktree), harness.store.getTask(task.id)!.worktreePath]).toEqual([
      false,
      null,
    ]);
  });

  it('deletes the merged branch', async () => {
    const { task } = await reviewedTask();
    await harness.mergeTask(task.id);
    expect(git(repo, 'branch', '--list', 'hb/*')).toBe('');
  });

  it('records the merge', async () => {
    const { task } = await reviewedTask();
    const merged = await harness.mergeTask(task.id);
    expect(harness.lastMerge(task.id)).toEqual({
      base: 'main',
      branch: 'hb/1-add-a-greeting',
      commit: git(repo, 'rev-parse', 'main'),
    });
    expect(merged.status).toBe('merged');
  });
});

describe('merging into a base that is not checked out', () => {
  it('moves the base without touching the checkout', async () => {
    const { task } = await reviewedTask();
    git(repo, 'checkout', '-q', '-b', 'other');
    await harness.mergeTask(task.id);
    expect([existsSync(path.join(repo, 'hello.txt')), git(repo, 'show', 'main:hello.txt')]).toEqual(
      [false, 'hi'],
    );
  });
});

describe('merging into a checkout with local changes in the way', () => {
  it('refuses and leaves the base where it was', async () => {
    const { task } = await reviewedTask();
    const before = git(repo, 'rev-parse', 'main');
    writeFileSync(path.join(repo, 'hello.txt'), 'mine\n');
    await expect(harness.mergeTask(task.id)).rejects.toThrow(/hello\.txt/);
    expect(git(repo, 'rev-parse', 'main')).toBe(before);
  });
});

describe('a merge that cannot start', () => {
  it('is refused for a task that is not in review', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, confirmPlan: false });
    await expect(harness.mergeTask(task.id)).rejects.toThrow(/not review/);
  });

  it('is refused while the worktree has uncommitted changes', async () => {
    const { task, worktree } = await reviewedTask();
    writeFileSync(path.join(worktree, 'loose.txt'), 'x\n');
    await expect(harness.mergeTask(task.id)).rejects.toThrow(/uncommitted changes/);
  });

  it('is refused when the base already has every commit', async () => {
    scenario([[init(), result('done')]]);
    const task = await harness.createTask({
      prompt: 'x',
      repo,
      confirmPlan: false,
      reviewer: null,
      queue: true,
    });
    await harness.waitForIdle();
    await expect(harness.mergeTask(task.id)).rejects.toThrow(/already has every commit/);
  });
});

describe('merging a task whose base changed the same lines', () => {
  async function conflicted() {
    const reviewed = await reviewedTask([[init(), result('resolved')]]);
    commitFile(repo, 'hello.txt', 'hello from main\n');
    const merge = await harness.mergeTask(reviewed.task.id);
    await harness.waitForIdle();
    return { ...reviewed, merge };
  }

  it('reports the conflicting files', async () => {
    const { merge } = await conflicted();
    expect(merge).toEqual({ status: 'conflicts', base: 'main', files: ['hello.txt'] });
  });

  it('leaves the base unchanged', async () => {
    await conflicted();
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('hello.txt');
  });

  it('starts merging the base in the task worktree', async () => {
    const { worktree } = await conflicted();
    expect(readFileSync(path.join(worktree, 'hello.txt'), 'utf8')).toContain('<<<<<<<');
  });

  it('asks the agent to resolve the conflicts', async () => {
    await conflicted();
    expect(fakeRuns()[1]!.received[0]).toContain('These files have conflicts:\n- hello.txt');
  });

  it('brings the task back for review afterwards', async () => {
    const { task } = await conflicted();
    expect(harness.store.getTask(task.id)!.status).toBe('review');
  });

  it('merges once the agent committed the resolution', async () => {
    const { task, worktree } = await conflicted();
    commitFile(worktree, 'hello.txt', 'hi and hello\n');
    await harness.mergeTask(task.id);
    expect(readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toBe('hi and hello\n');
  });
});
