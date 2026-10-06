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
  askBash,
  assistantText,
  commitAll,
  hang,
  init,
  makeRepo,
  result,
  tempDir,
  writeFile,
  writeScenario,
} from './helpers.js';

interface FakeRun {
  args: string[];
  cwd: string;
  received: string[];
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

/** A session that writes nothing but leaves a conversation a chat can continue. */
const TALK = [init(), assistantText('done', 10_000), result('done')];

/** A base task that was marked done, then a second base task now waiting for review. */
async function doneTaskWhileAnotherHoldsTheFolder() {
  scenario([TALK], [TALK]);
  const first = await createBaseTask();
  await harness.waitForIdle();
  harness.completeTask(first.id);
  await createBaseTask('Another change');
  await harness.waitForIdle();
  return first;
}

describe('a chat with a base task while another one holds the folder', () => {
  it('is refused', async () => {
    const first = await doneTaskWhileAnotherHoldsTheFolder();
    expect(() => harness.chat(first.id, 'One more thing')).toThrow(
      `task 2 already works directly on main in ${repo} (review); ` +
        'finish or stop it before starting task 1',
    );
  });

  it('runs no agent', async () => {
    const first = await doneTaskWhileAnotherHoldsTheFolder();
    expect(() => harness.chat(first.id, 'One more thing')).toThrow();
    await harness.waitForIdle();
    expect(fakeRuns()).toHaveLength(2);
  });

  it('keeps a pending message unsent', async () => {
    const first = await doneTaskWhileAnotherHoldsTheFolder();
    harness.store.appendEvent(first.id, null, 'chat_queued', { text: 'One more thing' });
    harness.tick();
    await harness.waitForIdle();
    expect([fakeRuns().length, harness.pendingChat(first.id)]).toEqual([2, ['One more thing']]);
  });
});

describe('a chat with a base task whose conversation is full', () => {
  it('is refused without suggesting hb open, which refuses base tasks', async () => {
    scenario([TALK]);
    const task = await createBaseTask();
    await harness.waitForIdle();
    const [first] = harness.store.listSessions(task.id);
    harness.store.updateSessionContext(first!.id, 90_000, 100_000);
    expect(() => harness.chat(task.id, 'One more thing')).toThrow(
      /^the conversation of task 1 is full$/,
    );
  });
});

describe('a base task after the folder switched to another branch', () => {
  it('fails to restart without running an agent', async () => {
    scenario([TALK], [TALK]);
    const task = await createBaseTask();
    await harness.waitForIdle();
    git(repo, 'checkout', '-q', '-b', 'other');
    harness.queueTask(task.id);
    await harness.waitForIdle();
    expect([harness.store.getTask(task.id)!.status, fakeRuns().length]).toEqual(['failed', 1]);
  });

  it('refuses a chat without running an agent', async () => {
    scenario([TALK], [TALK]);
    const task = await createBaseTask();
    await harness.waitForIdle();
    git(repo, 'checkout', '-q', '-b', 'other');
    harness.chat(task.id, 'One more thing');
    await harness.waitForIdle();
    const notice = harness.store.lastEvent(task.id, 'notice')!.data as { message: string };
    expect([harness.store.getTask(task.id)!.status, fakeRuns().length, notice.message]).toEqual([
      'review',
      1,
      `chat failed: task 1 works directly on main, but ${repo} does not have that branch ` +
        'checked out; check it out there and start the task again',
    ]);
  });

  it('counts again from where the folder is when restarted on its branch again', async () => {
    scenario([TALK], [TALK]);
    const task = await createBaseTask();
    await harness.waitForIdle();
    git(repo, 'checkout', '-q', '-b', 'other');
    harness.queueTask(task.id);
    await harness.waitForIdle();
    git(repo, 'checkout', '-q', 'main');
    commitFile(repo, 'later.txt', 'user work\n');
    const later = git(repo, 'rev-parse', 'HEAD');
    harness.queueTask(task.id);
    await harness.waitForIdle();
    expect([fakeRuns().length, harness.store.getTask(task.id)!.startCommit]).toEqual([2, later]);
  });
});

const ADD_WORLD = [init(), writeFile('world.txt', 'w\n'), commitAll('add world.txt'), result('ok')];
const ADD_BYE = [init(), writeFile('bye.txt', 'bye\n'), commitAll('add bye.txt'), result('ok')];

/**
 * Base task 1 committed hello.txt and is done; base task 2 then committed world.txt and is
 * done. A chat with task 1 after that commits bye.txt.
 */
async function doneTaskThenAnother() {
  const addHelloAndTalk = [
    init(),
    writeFile('hello.txt', 'hi\n'),
    commitAll('add hello.txt'),
    assistantText('done', 10_000),
    result('done'),
  ];
  scenario([addHelloAndTalk], [ADD_WORLD], [ADD_BYE]);
  const first = await createBaseTask();
  await harness.waitForIdle();
  harness.completeTask(first.id);
  const second = await createBaseTask('Another change');
  await harness.waitForIdle();
  harness.completeTask(second.id);
  return first;
}

describe('a done base task after another base task worked in the folder', () => {
  it('shows only its own changes', async () => {
    const first = await doneTaskThenAnother();
    const { diff } = await harness.diff(first.id);
    expect([diff.includes('hello.txt'), diff.includes('world.txt')]).toEqual([true, false]);
  });

  it('lists only its own commits', async () => {
    const first = await doneTaskThenAnother();
    const commits = await harness.commits(first.id);
    expect(commits.map((c) => c.subject)).toEqual(['add hello.txt']);
  });

  it('does not list uncommitted files left in the folder later', async () => {
    const first = await doneTaskThenAnother();
    writeFileSync(path.join(repo, 'draft.txt'), 'not committed\n');
    expect((await harness.diff(first.id)).untracked).toEqual([]);
  });

  it('lists its own commits from before and after a chat, but not the other task', async () => {
    const first = await doneTaskThenAnother();
    harness.chat(first.id, 'Say goodbye too');
    await harness.waitForIdle();
    const commits = await harness.commits(first.id);
    expect(commits.map((c) => c.subject)).toEqual(['add bye.txt', 'add hello.txt']);
  });
});

async function waitForStatus(id: number, status: string): Promise<void> {
  while (harness.store.getTask(id)!.status !== status) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Base task 1 committed hello.txt and was stopped while asking for permission; base task 2
 * then committed world.txt and is done; task 1 was resumed and committed bye.txt.
 */
async function stoppedTaskResumedAfterAnother() {
  scenario(
    [
      [
        init(),
        writeFile('hello.txt', 'hi\n'),
        commitAll('add hello.txt'),
        askBash('r1', 'node hello.js', 'node *'),
        hang,
      ],
    ],
    [ADD_WORLD],
    [ADD_BYE],
  );
  const first = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    workspace: 'base',
    confirmPlan: false,
    reviewer: null,
    autoApprove: false,
    queue: true,
  });
  await waitForStatus(first.id, 'awaiting_permission');
  harness.stopTask(first.id);
  await harness.waitForIdle();
  const second = await createBaseTask('Another change');
  await harness.waitForIdle();
  harness.completeTask(second.id);
  harness.queueTask(first.id);
  await harness.waitForIdle();
  return first;
}

describe('a stopped base task resumed after another base task worked in the folder', () => {
  it('lists its own commits from before and after, but not the other task', async () => {
    const first = await stoppedTaskResumedAfterAnother();
    const commits = await harness.commits(first.id);
    expect(commits.map((c) => c.subject)).toEqual(['add bye.txt', 'add hello.txt']);
  });

  it('shows its own changes from before and after, but not the other task', async () => {
    const first = await stoppedTaskResumedAfterAnother();
    const { diff } = await harness.diff(first.id);
    expect([
      diff.includes('hello.txt'),
      diff.includes('bye.txt'),
      diff.includes('world.txt'),
    ]).toEqual([true, true, false]);
  });
});

describe('an approved base task resumed after another base task worked in the folder', () => {
  it('asks for a review from where it came back, not of the other task', async () => {
    scenario(
      [ADD_HELLO],
      [[init(), result('VERDICT: APPROVE')]],
      [ADD_WORLD],
      [ADD_BYE],
      [[init(), result('VERDICT: APPROVE')]],
    );
    const first = await harness.createTask({
      prompt: 'Add a greeting',
      repo,
      workspace: 'base',
      confirmPlan: false,
      reviewer: 'claude',
      queue: true,
    });
    await harness.waitForIdle();
    harness.tick(); // the reviewer's session
    await harness.waitForIdle();
    // Sent back while the folder is on another branch, so it fails and lets go of the folder.
    git(repo, 'checkout', '-q', '-b', 'other');
    harness.queueTask(first.id);
    await harness.waitForIdle();
    git(repo, 'checkout', '-q', 'main');
    const second = await createBaseTask('Another change');
    await harness.waitForIdle();
    harness.completeTask(second.id);
    const back = git(repo, 'rev-parse', 'HEAD');
    harness.queueTask(first.id);
    await harness.waitForIdle();
    const request = harness.store.lastEvent(first.id, 'review_request')!.data as { since: string };
    expect(request.since).toBe(back);
  });
});

describe('a base task stopped before its first review and resumed after another base task', () => {
  async function resumedRequest() {
    scenario(
      [
        [
          init(),
          writeFile('hello.txt', 'hi\n'),
          commitAll('add hello.txt'),
          askBash('r1', 'node hello.js', 'node *'),
          hang,
        ],
      ],
      [ADD_WORLD],
      [ADD_BYE],
      [[init(), result('VERDICT: APPROVE')]],
    );
    const start = git(repo, 'rev-parse', 'HEAD');
    const first = await harness.createTask({
      prompt: 'Add a greeting',
      repo,
      workspace: 'base',
      confirmPlan: false,
      reviewer: 'claude',
      autoApprove: false,
      queue: true,
    });
    await waitForStatus(first.id, 'awaiting_permission');
    const hello = git(repo, 'rev-parse', 'HEAD');
    harness.stopTask(first.id);
    await harness.waitForIdle();
    const second = await createBaseTask('Another change');
    await harness.waitForIdle();
    harness.completeTask(second.id);
    const back = git(repo, 'rev-parse', 'HEAD');
    harness.queueTask(first.id);
    await harness.waitForIdle();
    const request = harness.store.lastEvent(first.id, 'review_request')!.data as {
      since: string;
      earlier?: { from: string; to: string }[];
    };
    return { request, start, hello, back };
  }

  it('asks for a review of its stretch from before the other task as well', async () => {
    const { request, start, hello } = await resumedRequest();
    expect(request.earlier).toEqual([{ from: start, to: hello }]);
  });

  it('asks for a review of its current stretch from where it came back', async () => {
    const { request, back } = await resumedRequest();
    expect(request.since).toBe(back);
  });
});

describe('a base task whose spec author left the spec uncommitted', () => {
  it('counts the spec commit the harness made as its own work', async () => {
    const proposal = 'I read main.js.\n## Acceptance criteria\n- prints hi';
    scenario(
      [[init(), assistantText(proposal, 10_000), result(proposal)]],
      [[init(), writeFile('docs/specs/001-add-a-greeting.md', '# Spec'), result('written')]],
      [ADD_HELLO],
    );
    const task = await harness.createTask({
      prompt: 'Add a greeting',
      repo,
      workspace: 'base',
      reviewer: null,
      queue: true,
    });
    await harness.waitForIdle();
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    harness.tick(); // the implementer's session
    await harness.waitForIdle();
    const commits = await harness.commits(task.id);
    expect(commits.map((c) => c.subject)).toEqual([
      'add hello.txt',
      'docs: add spec for Add a greeting',
    ]);
  });
});

/** A worktree task with a committed file waiting for review, then a base task (not started). */
async function reviewedWorktreeTaskAndBaseTask() {
  scenario(
    [[init(), writeFile('feature.txt', 'new\n'), commitAll('add feature'), result('ok')]],
    [TALK],
  );
  const worktree = await harness.createTask({
    prompt: 'Add a feature',
    repo,
    confirmPlan: false,
    reviewer: null,
    queue: true,
  });
  await harness.waitForIdle();
  const base = await createBaseTask('Work on main', false);
  return { worktree, base };
}

describe('merging a worktree task into a branch a base task works on', () => {
  async function refusedMerge() {
    const { worktree, base } = await reviewedWorktreeTaskAndBaseTask();
    harness.queueTask(base.id);
    await harness.waitForIdle();
    const head = git(repo, 'rev-parse', 'HEAD');
    const merge = harness.mergeTask(worktree.id);
    return { merge, head };
  }

  it('is refused', async () => {
    const { merge } = await refusedMerge();
    await expect(merge).rejects.toThrow(
      `task 2 works directly on main in ${repo} (review); finish or stop it before merging task 1`,
    );
  });

  it('leaves the base branch and the folder as they were', async () => {
    const { merge, head } = await refusedMerge();
    await merge.catch(() => {});
    expect([git(repo, 'rev-parse', 'HEAD'), existsSync(path.join(repo, 'feature.txt'))]).toEqual([
      head,
      false,
    ]);
  });
});

describe('a base task while a merge into its branch is in progress', () => {
  it('cannot be queued', async () => {
    const { worktree, base } = await reviewedWorktreeTaskAndBaseTask();
    const merge = harness.mergeTask(worktree.id);
    expect(() => harness.queueTask(base.id)).toThrow(
      `task 1 is being merged into main in ${repo}; start task 2 again once the merge is done`,
    );
    await merge;
  });

  it('can be queued once the merge is done', async () => {
    const { worktree, base } = await reviewedWorktreeTaskAndBaseTask();
    await harness.mergeTask(worktree.id);
    expect(harness.queueTask(base.id).status).toBe('queued');
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

describe('a base task whose session was cut off by a crash after committing', () => {
  it('keeps those commits as its work once it runs again after the restart', async () => {
    scenario([TALK]);
    const start = git(repo, 'rev-parse', 'HEAD');
    const task = await createBaseTask('Add a greeting', false);
    // What the store holds when the process dies mid-session: the end is where it started.
    harness.store.updateTask(task.id, {
      worktreePath: repo,
      startCommit: start,
      endCommit: start,
      status: 'running',
    });
    commitFile(repo, 'hello.txt', 'hi\n');
    const restarted = new Harness(harness.config, harness.store);
    await restarted.start();
    await restarted.waitForIdle();
    await restarted.shutdown();
    const commits = await restarted.commits(task.id);
    expect(commits.map((c) => c.subject)).toEqual(['add hello.txt']);
  });
});

async function waitUntil(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 20));
}

/** A session that has read something, so it can be resumed, and then runs until stopped. */
const READ_AND_HANG = [init(), assistantText('Reading the diff.', 10_000), hang];

/**
 * Base task 1 committed hello.txt and its `role` (reviewer or tester) was stopped partway;
 * base task 2 then committed world.txt and is done; task 1 was resumed and `role` answered
 * `reply`.
 */
async function checkResumedAfterAnother(role: 'reviewer' | 'tester', reply: string) {
  scenario([ADD_HELLO], [READ_AND_HANG], [ADD_WORLD], [[init(), result(reply)]]);
  const start = git(repo, 'rev-parse', 'HEAD');
  const first = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    workspace: 'base',
    confirmPlan: false,
    reviewer: role === 'reviewer' ? 'claude' : null,
    tester: role === 'tester' ? 'claude' : null,
    queue: true,
  });
  await harness.waitForIdle();
  const hello = git(repo, 'rev-parse', 'HEAD');
  harness.tick();
  await waitUntil(() => (harness.store.listSessions(first.id)[1]?.contextTokens ?? 0) > 0);
  harness.stopTask(first.id);
  await harness.waitForIdle();
  const second = await createBaseTask('Another change');
  await harness.waitForIdle();
  harness.completeTask(second.id);
  harness.queueTask(first.id);
  await harness.waitForIdle();
  return { first, start, hello, resumed: fakeRuns()[3]! };
}

describe('a base task whose reviewer was stopped and resumed after another base task', () => {
  it('takes the verdict instead of blaming the reviewer for the other commit', async () => {
    const { first } = await checkResumedAfterAnother('reviewer', 'VERDICT: APPROVE');
    const review = harness.store.lastEvent(first.id, 'review')!.data as { verdict: string };
    expect(review.verdict).toBe('approve');
  });

  it('resumes the reviewer with its own earlier stretch as the scope', async () => {
    const { start, hello, resumed } = await checkResumedAfterAnother(
      'reviewer',
      'VERDICT: APPROVE',
    );
    expect([
      resumed.args.includes('--resume'),
      resumed.received[0]!.startsWith('[harness] While you were stopped'),
      resumed.received[0]!.includes(`git diff ${start}..${hello}`),
    ]).toEqual([true, true, true]);
  });
});

describe('a base task whose tester was stopped and resumed after another base task', () => {
  it('takes the verdict instead of blaming the tester for the other commit', async () => {
    const { first } = await checkResumedAfterAnother('tester', 'TESTS: PASS');
    const report = harness.store.lastEvent(first.id, 'test_report')!.data as { verdict: string };
    expect(report.verdict).toBe('pass');
  });

  it('resumes the tester with its own earlier stretch as the scope', async () => {
    const { start, hello, resumed } = await checkResumedAfterAnother('tester', 'TESTS: PASS');
    expect([
      resumed.args.includes('--resume'),
      resumed.received[0]!.startsWith('[harness] While you were stopped'),
      resumed.received[0]!.includes(`git diff ${start}..${hello}`),
    ]).toEqual([true, true, true]);
  });
});
