// SPDX-License-Identifier: Apache-2.0
// The optional UI designer: adds a UI design section to the spec before anything is built.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateTaskInput } from '@harnessboard/shared';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
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
  received: string[];
}

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('designer');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  const profile = { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null };
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: { claude: profile, writer: profile, artist: profile, checker: profile },
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

const SPEC_PATH = 'docs/specs/001-add-a-greeting.md';
const PROPOSAL = 'I read main.js.\n## Acceptance criteria\n- prints hi';
const DESIGN_DUTY = 'Its "UI design" section is how the user interface must look and behave';

const session = (reply: string, ...actions: unknown[]) => [
  [init(), assistantText(reply, 10_000), ...actions, result(reply)],
];
const discussion = session(PROPOSAL);
const specFile = session('spec written', writeFile(SPEC_PATH, '# Spec\n'));
const design = session(
  'design written',
  writeFile(SPEC_PATH, '# Spec\n\n## UI design\n\nA button.\n'),
);
const implementation = session(
  'done',
  writeFile('hello.txt', 'hi'),
  commitAll('feat: add greeting'),
);

const sessions = (id: number) => harness.store.listSessions(id).map((s) => [s.role, s.agentId]);
const status = (id: number) => harness.store.getTask(id)!.status;
const notices = (id: number) =>
  harness.store.eventsOfKind(id, 'notice').map((e) => (e.data as { message: string }).message);

async function runQueued(): Promise<void> {
  harness.tick();
  await harness.waitForIdle();
}

/** Agrees on the criteria, approves them, and runs every session that follows. */
async function approved(extra: Partial<CreateTaskInput>) {
  const task = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    queue: true,
    reviewer: null,
    ...extra,
  });
  await harness.waitForIdle();
  harness.approveCriteria(task.id);
  await harness.waitForIdle();
  await runQueued(); // the designer
  await runQueued(); // the implementer, then any reviewer
  return task;
}

describe('a task with a designer', () => {
  beforeEach(() => scenario(discussion, specFile, design, implementation));

  it('runs the designer between the spec author and the implementer', async () => {
    const task = await approved({ spec: 'writer', designer: 'artist' });
    // Writing the spec continues the discussion, which keeps its record.
    expect(sessions(task.id)).toEqual([
      ['spec', 'writer'],
      ['designer', 'artist'],
      ['implementer', 'claude'],
    ]);
  });

  it('lets the designer edit, in a session of its own', async () => {
    await approved({ spec: 'writer', designer: 'artist' });
    const args = fakeRuns()[2]!.args;
    expect([args.includes('--resume'), args.includes('acceptEdits')]).toEqual([false, true]);
  });

  it('asks the designer for a UI design section in the spec file', async () => {
    await approved({ spec: 'writer', designer: 'artist' });
    const prompt = fakeRuns()[2]!.received[0] as string;
    expect([prompt.includes(`\`## UI design\` to \`${SPEC_PATH}\``)]).toEqual([true]);
  });

  it('commits the design the designer left uncommitted', async () => {
    const task = await approved({ spec: 'writer', designer: 'artist' });
    const worktree = harness.store.getTask(task.id)!.worktreePath!;
    const committed = execFileSync('git', ['-C', worktree, 'show', `HEAD:${SPEC_PATH}`], {
      encoding: 'utf8',
    });
    expect(committed).toBe('# Spec\n\n## UI design\n\nA button.\n');
  });

  it('records the design on the task', async () => {
    const task = await approved({ spec: 'writer', designer: 'artist' });
    expect(harness.store.eventsOfKind(task.id, 'design_written').map((e) => e.data)).toEqual([
      expect.objectContaining({ path: SPEC_PATH }),
    ]);
  });

  it('tells the implementer to follow the design', async () => {
    await approved({ spec: 'writer', designer: 'artist' });
    expect((fakeRuns()[3]!.received[0] as string).includes(DESIGN_DUTY)).toBe(true);
  });

  it('tells the implementer that continues the discussion to follow the design', async () => {
    await approved({ designer: 'artist' });
    const run = fakeRuns()[3]!;
    expect([
      run.args.includes('--resume'),
      (run.received[0] as string).includes(DESIGN_DUTY),
    ]).toEqual([true, true]);
  });

  it('ends at review once the implementer is done', async () => {
    const task = await approved({ spec: 'writer', designer: 'artist' });
    expect(status(task.id)).toBe('review');
  });
});

describe('the reviewer of a designed task', () => {
  it('is told to check the work against the design', async () => {
    scenario(discussion, specFile, design, implementation, session('VERDICT: APPROVE'));
    const task = await approved({ spec: 'writer', designer: 'artist', reviewer: 'checker' });
    await runQueued(); // the reviewer
    expect([
      sessions(task.id).at(-1),
      (fakeRuns()[4]!.received[0] as string).includes(DESIGN_DUTY),
    ]).toEqual([['reviewer', 'checker'], true]);
  });
});

describe('a task without a designer', () => {
  beforeEach(() => scenario(discussion, specFile, implementation));

  it('goes from the spec author straight to the implementer', async () => {
    const task = await approved({ spec: 'writer' });
    expect(sessions(task.id)).toEqual([
      ['spec', 'writer'],
      ['implementer', 'claude'],
    ]);
  });

  it('does not mention a UI design to the implementer', async () => {
    await approved({ spec: 'writer' });
    expect((fakeRuns()[2]!.received[0] as string).includes('UI design')).toBe(false);
  });

  it('records no design', async () => {
    const task = await approved({ spec: 'writer' });
    expect(harness.store.eventsOfKind(task.id, 'design_written')).toEqual([]);
  });
});

describe('a designer that does not write the design properly', () => {
  it('stops the task when it changes other files', async () => {
    const stray = session(
      'designed',
      writeFile(SPEC_PATH, '# Spec\n\n## UI design\n'),
      writeFile('main.js', 'oops'),
    );
    scenario(discussion, specFile, stray, implementation);
    const task = await approved({ spec: 'writer', designer: 'artist' });
    expect([status(task.id), notices(task.id).at(-1)]).toEqual([
      'failed',
      'the designer changed files other than the spec: main.js; stopping for a human',
    ]);
  });

  it('stops the task when it adds no UI design section', async () => {
    scenario(discussion, specFile, session('nothing written'), implementation);
    const task = await approved({ spec: 'writer', designer: 'artist' });
    expect([status(task.id), notices(task.id).at(-1)]).toEqual([
      'failed',
      `the designer did not add a UI design section to ${SPEC_PATH}`,
    ]);
  });

  it('does not start the implementer', async () => {
    scenario(discussion, specFile, session('nothing written'), implementation);
    const task = await approved({ spec: 'writer', designer: 'artist' });
    expect(sessions(task.id).map(([role]) => role)).toEqual(['spec', 'designer']);
  });
});

describe('a designer chosen after the implementer started', () => {
  it('is not run', async () => {
    scenario(discussion, specFile, implementation, session('more work'));
    const task = await approved({ spec: 'writer' });
    harness.setAgents(task.id, { designer: 'artist' });
    harness.queueTask(task.id);
    await harness.waitForIdle();
    expect(sessions(task.id).map(([role]) => role)).toEqual(['spec', 'implementer']);
  });
});

const REVISED = '## Changes\n- Hello, not hi.\n## Acceptance criteria\n- prints hello';
const designerStopped = [[init(), assistantText('designing', 10_000), hang]];

/** Approves the criteria, then stops the designer as it works and asks for a spec change. */
async function revisedBeforeDesign() {
  const task = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    queue: true,
    reviewer: null,
    spec: 'writer',
    designer: 'artist',
  });
  await harness.waitForIdle();
  harness.approveCriteria(task.id);
  await harness.waitForIdle();
  harness.tick(); // the designer starts and hangs
  await new Promise((r) => setTimeout(r, 300));
  harness.stopTask(task.id);
  await harness.waitForIdle();
  harness.requestSpecRevision(task.id, 'Say hello instead');
  await harness.waitForIdle(); // the spec author proposes the change
  return task;
}

describe('a spec change decided while the design is unwritten', () => {
  beforeEach(() =>
    scenario(discussion, specFile, designerStopped, session(REVISED), design, implementation),
  );

  it('runs the designer before the implementer once the change is approved', async () => {
    const task = await revisedBeforeDesign();
    harness.approveSpecChange(task.id);
    await harness.waitForIdle(); // the designer
    await runQueued(); // the implementer
    expect(sessions(task.id).map(([role]) => role)).toEqual([
      'spec',
      'designer',
      'spec',
      'designer',
      'implementer',
    ]);
  });

  it('runs the designer before the implementer once the change is rejected', async () => {
    const task = await revisedBeforeDesign();
    harness.rejectSpecChange(task.id);
    await harness.waitForIdle(); // the designer
    await runQueued(); // the implementer
    expect(sessions(task.id).map(([role]) => role)).toEqual([
      'spec',
      'designer',
      'spec',
      'designer',
      'implementer',
    ]);
  });

  it('gives the implementer the approved criteria as it starts, and not again after', async () => {
    const task = await revisedBeforeDesign();
    harness.approveSpecChange(task.id);
    await harness.waitForIdle(); // the designer
    await runQueued(); // the implementer
    expect([
      fakeRuns()[5]!.received[0]!.includes('- prints hello'),
      status(task.id),
      sessions(task.id).length,
    ]).toEqual([true, 'review', 5]);
  });
});

describe('a designer of a task on the base branch', () => {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();

  /**
   * Stops the designer as it works, then the user commits `other.txt` in the folder.
   * `committed` names a commit the designer makes first; stopping waits for it, since
   * git is slow enough on Windows to be cut off by a fixed pause.
   */
  async function interrupted(committed?: string) {
    const task = await harness.createTask({
      prompt: 'Add a greeting',
      repo,
      workspace: 'base',
      queue: true,
      reviewer: null,
      spec: 'writer',
      designer: 'artist',
    });
    await harness.waitForIdle();
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    harness.tick(); // the designer starts and hangs
    await new Promise((r) => setTimeout(r, 300));
    while (committed !== undefined && git('log', '-1', '--format=%s') !== committed) {
      await new Promise((r) => setTimeout(r, 100));
    }
    harness.stopTask(task.id);
    await harness.waitForIdle();
    writeFileSync(path.join(repo, 'other.txt'), 'theirs');
    git('add', 'other.txt');
    git('commit', '-q', '-m', 'add other.txt');
    harness.queueTask(task.id);
    await harness.waitForIdle(); // the designer again
    return task;
  }

  it('is not blamed for a commit made in the folder while it was stopped', async () => {
    scenario(discussion, specFile, designerStopped, design);
    const task = await interrupted();
    expect([status(task.id), notices(task.id).at(-1)]).toEqual([
      'queued',
      `UI design committed in ${SPEC_PATH}`,
    ]);
  });

  it('is still stopped for a file it committed itself before it was stopped', async () => {
    const stray = [
      [
        init(),
        writeFile('notes.txt', 'mine'),
        commitAll('notes'),
        assistantText('x', 10_000),
        hang,
      ],
    ];
    scenario(discussion, specFile, stray, design);
    const task = await interrupted('notes');
    expect([status(task.id), notices(task.id).at(-1)]).toEqual([
      'failed',
      'the designer changed files other than the spec: notes.txt; stopping for a human',
    ]);
  });
});

describe('changing the designer of a task', () => {
  it('is saved with its model', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, reviewer: null });
    const updated = harness.setAgents(task.id, { designer: 'artist', designerModel: 'opus' });
    expect([updated.agents.designer, updated.agents.designerModel]).toEqual(['artist', 'opus']);
  });

  it('is refused for a profile that is not configured', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, reviewer: null });
    expect(() => harness.setAgents(task.id, { designer: 'nobody' })).toThrow(/not configured/);
  });

  it('is off by default', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, reviewer: null });
    expect(task.agents.designer).toBeNull();
  });
});
