// SPDX-License-Identifier: Apache-2.0
// The task's notes file: what each role reports to the roles after it, kept by the harness.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateTaskInput } from '@harnessboard/shared';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { parseNotes } from '../src/notes.js';
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
  args: string[];
  received: string[];
}

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('notes');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: {
      claude: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null },
      qa: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null },
      checker: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null },
    },
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

const session = (text: string, ...writes: unknown[]) => [
  [init(), ...writes, commitAll('test: record stage work'), result(text)],
];
const notesFile = (id: number) =>
  path.join(harness.store.getTask(id)!.worktreePath!, '.harnessboard', 'notes.md');
const notes = (id: number) => readFileSync(notesFile(id), 'utf8');

async function runQueued(): Promise<void> {
  harness.tick();
  await harness.waitForIdle();
}

async function created(extra: Partial<CreateTaskInput> = {}) {
  const task = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    confirmPlan: false,
    queue: true,
    reviewer: null,
    ...extra,
  });
  await harness.waitForIdle();
  return task;
}

const implemented = session(
  'Done.\n\n## Notes\nAdded greet() in hello.txt; kept it plain text.',
  writeFile('hello.txt', 'hi'),
);
const passing = session('TESTS: PASS\nall criteria covered', writeFile('hello.test.js', 'ok'));

describe('a finished implementer step', () => {
  it('writes its notes section to the notes file', async () => {
    scenario(implemented);
    const task = await created();
    expect(notes(task.id)).toContain('Added greet() in hello.txt; kept it plain text.');
  });

  it('heads the note with the role and agent', async () => {
    scenario(implemented);
    const task = await created();
    expect(notes(task.id)).toContain('## 1. Implementer (claude) · ');
  });

  it('keeps the notes file out of git', async () => {
    scenario(implemented);
    const task = await created();
    const ignored = execFileSync('git', ['check-ignore', '.harnessboard/notes.md'], {
      cwd: harness.store.getTask(task.id)!.worktreePath!,
      encoding: 'utf8',
    });
    expect(ignored.trim()).toBe('.harnessboard/notes.md');
  });
});

describe('the role after the implementer', () => {
  it('only consults the notes archive when history is needed', async () => {
    scenario(implemented, passing);
    await created({ tester: 'qa' });
    await runQueued();
    expect(fakeRuns()[1]!.received[0]).not.toContain('Before you start, read');
    expect(fakeRuns()[1]!.received[0]).toContain('Consult them only when');
  });

  it('has its verdict in the heading of its note', async () => {
    scenario(implemented, passing);
    const task = await created({ tester: 'qa' });
    await runQueued();
    expect(notes(task.id)).toContain('## 2. Tester (qa) · tests pass · ');
  });

  it('is recorded with its whole reply when it wrote no notes section', async () => {
    scenario(implemented, passing);
    const task = await created({ tester: 'qa' });
    await runQueued();
    expect(notes(task.id)).toContain('TESTS: PASS\nall criteria covered');
  });
});

describe('an agent that edits the notes file', () => {
  const tampering = session('TESTS: PASS', writeFile('.harnessboard/notes.md', 'all good'));

  it('is not treated as changing more than tests', async () => {
    scenario(implemented, tampering);
    const task = await created({ tester: 'qa' });
    await runQueued();
    expect(harness.store.getTask(task.id)!.status).toBe('review');
  });

  it('has its edit replaced by the recorded notes', async () => {
    scenario(implemented, tampering);
    const task = await created({ tester: 'qa' });
    await runQueued();
    expect(notes(task.id)).toContain('## 1. Implementer (claude)');
  });
});

describe('the discussion with the user', () => {
  it('writes no notes', async () => {
    scenario(session('## Acceptance criteria\n- prints hi'));
    const task = await created({ confirmPlan: true });
    expect(existsSync(notesFile(task.id))).toBe(false);
  });
});

describe('parseNotes', () => {
  it('returns the notes section without its heading', () => {
    expect(parseNotes('Done.\n\n## Notes\nused a map')).toBe('used a map');
  });

  it('stops at the next heading', () => {
    expect(parseNotes('## Notes\nused a map\n## Other\nx')).toBe('used a map');
  });

  it('keeps deeper headings inside the section', () => {
    expect(parseNotes('## Notes\n### Risks\nnone')).toBe('### Risks\nnone');
  });

  it('returns the whole reply when there is no notes section', () => {
    expect(parseNotes('  VERDICT: APPROVE\nfine  ')).toBe('VERDICT: APPROVE\nfine');
  });
});
