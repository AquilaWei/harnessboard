// SPDX-License-Identifier: Apache-2.0
// Tasks that work directly on the base branch in the repository folder, with real git.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
  commitAll,
  init,
  makeRepo,
  result,
  tempDir,
  writeFile,
  writeScenario,
} from './helpers.js';

interface FakeRun {
  cwd: string;
}

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('base');
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
  return readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as FakeRun);
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** Writes and commits a file, as an agent (or the user) would. */
function commitFile(cwd: string, file: string, content: string): void {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', `add ${file}`);
}

function createBaseTask(prompt = 'Add a greeting', queue = true) {
  return harness.createTask({
    prompt,
    repo,
    workspace: 'base',
    confirmPlan: false,
    reviewer: null,
    queue,
  });
}

const ADD_HELLO = [
  init(),
  writeFile('hello.txt', 'hi\n'),
  commitAll('add hello.txt'),
  result('done'),
];

/** A base task whose session wrote and committed a file, waiting in review. */
async function reviewedBaseTask() {
  scenario([ADD_HELLO]);
  const task = await createBaseTask();
  await harness.waitForIdle();
  return task;
}

describe('creating a task', () => {
  it('works in a worktree when no workspace is given', async () => {
    const task = await harness.createTask({ prompt: 'x', repo });
    expect(task.workspace).toBe('worktree');
  });

  it('records the base workspace', async () => {
    const task = await createBaseTask('x', false);
    expect(task.workspace).toBe('base');
  });

  it('refuses an unknown workspace', async () => {
    await expect(
      harness.createTask({ prompt: 'x', repo, workspace: 'elsewhere' as 'base' }),
    ).rejects.toThrow('unknown workspace elsewhere; use worktree or base');
  });
});

describe('running a base task', () => {
  it('runs its session in the repository folder', async () => {
    await reviewedBaseTask();
    expect(fakeRuns().map((r) => r.cwd)).toEqual([repo]);
  });

  it('writes its files in the repository folder', async () => {
    await reviewedBaseTask();
    expect(readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toBe('hi\n');
  });

  it('records the repository folder as where it works', async () => {
    const task = await reviewedBaseTask();
    expect(harness.store.getTask(task.id)!.worktreePath).toBe(repo);
  });

  it('creates no worktree', async () => {
    await reviewedBaseTask();
    expect([
      git(repo, 'worktree', 'list').split('\n'),
      existsSync(path.join(dir, 'data', 'wt')),
    ]).toEqual([[expect.stringContaining(repo)], false]);
  });

  it('creates no branch', async () => {
    const task = await reviewedBaseTask();
    expect([
      git(repo, 'branch', '--format=%(refname:short)'),
      harness.store.getTask(task.id)!.branch,
    ]).toEqual(['main', null]);
  });

  it('commits on the base branch', async () => {
    await reviewedBaseTask();
    expect(git(repo, 'show', 'main:hello.txt')).toBe('hi');
  });

  it('records the commit the base was at when it started', async () => {
    const start = git(repo, 'rev-parse', 'HEAD');
    const task = await reviewedBaseTask();
    expect(harness.store.getTask(task.id)!.startCommit).toBe(start);
  });

  it('fails with a clear notice when the base is not checked out in the folder', async () => {
    git(repo, 'checkout', '-q', '-b', 'other');
    scenario([[init(), result('done')]]);
    const task = await harness.createTask({
      prompt: 'x',
      repo,
      baseRef: 'main',
      workspace: 'base',
      confirmPlan: false,
      reviewer: null,
      queue: true,
    });
    await harness.waitForIdle();
    const notice = harness.store.lastEvent(task.id, 'notice')!.data as { message: string };
    expect([harness.store.getTask(task.id)!.status, notice.message]).toEqual([
      'failed',
      `task failed: task 1 works directly on main, but ${repo} does not have that branch ` +
        'checked out; check it out there and start the task again',
    ]);
  });
});

describe('reviewing a base task', () => {
  it('shows only the changes made since the task started', async () => {
    commitFile(repo, 'before.txt', 'earlier work\n');
    const task = await reviewedBaseTask();
    const { diff } = await harness.diff(task.id);
    expect([diff.includes('hello.txt'), diff.includes('before.txt')]).toEqual([true, false]);
  });

  it('lists only the commits made since the task started', async () => {
    commitFile(repo, 'before.txt', 'earlier work\n');
    const task = await reviewedBaseTask();
    const commits = await harness.commits(task.id);
    expect(commits.map((c) => c.subject)).toEqual(['add hello.txt']);
  });

  it('goes straight to done when approved, without a merge commit', async () => {
    const task = await reviewedBaseTask();
    const head = git(repo, 'rev-parse', 'HEAD');
    harness.completeTask(task.id);
    expect([harness.store.getTask(task.id)!.status, git(repo, 'rev-parse', 'HEAD')]).toEqual([
      'done',
      head,
    ]);
  });

  it('refuses to merge, since its commits are on the base already', async () => {
    const task = await reviewedBaseTask();
    await expect(harness.mergeTask(task.id)).rejects.toThrow(
      'task 1 works directly on main, so there is nothing to merge; mark it done',
    );
  });
});

describe('a base task with a reviewer', () => {
  it('asks for a review of the commits since the task started', async () => {
    commitFile(repo, 'before.txt', 'earlier work\n');
    const start = git(repo, 'rev-parse', 'HEAD');
    scenario([ADD_HELLO], [[init(), result('Looks fine.')]]);
    const task = await harness.createTask({
      prompt: 'Add a greeting',
      repo,
      workspace: 'base',
      confirmPlan: false,
      reviewer: 'claude',
      queue: true,
    });
    await harness.waitForIdle();
    const request = harness.store.lastEvent(task.id, 'review_request')!.data as { since: string };
    expect(request.since).toBe(start);
  });
});

describe('a second base task on the same repository', () => {
  it('is refused while the first one waits for review', async () => {
    await reviewedBaseTask();
    const second = await createBaseTask('Another change', false);
    expect(() => harness.queueTask(second.id)).toThrow(
      `task 1 already works directly on main in ${repo} (review); ` +
        'finish or stop it before starting task 2',
    );
  });

  it('can start once the first one is done', async () => {
    const first = await reviewedBaseTask();
    harness.completeTask(first.id);
    const second = await createBaseTask('Another change', false);
    expect(harness.queueTask(second.id).status).toBe('queued');
  });

  it('does not keep a worktree task from starting', async () => {
    await reviewedBaseTask();
    const other = await harness.createTask({ prompt: 'x', repo, confirmPlan: false });
    expect(harness.queueTask(other.id).status).toBe('queued');
  });
});

describe('deleting a base task', () => {
  it('keeps the repository folder and its files', async () => {
    const task = await reviewedBaseTask();
    await harness.deleteTask(task.id);
    expect(readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toBe('hi\n');
  });

  it('keeps every branch', async () => {
    const task = await reviewedBaseTask();
    await harness.deleteTask(task.id);
    expect(git(repo, 'branch', '--format=%(refname:short)')).toBe('main');
  });

  it('keeps uncommitted changes in the folder', async () => {
    const task = await reviewedBaseTask();
    writeFileSync(path.join(repo, 'draft.txt'), 'not committed\n');
    await harness.deleteTask(task.id);
    expect(readFileSync(path.join(repo, 'draft.txt'), 'utf8')).toBe('not committed\n');
  });
});
