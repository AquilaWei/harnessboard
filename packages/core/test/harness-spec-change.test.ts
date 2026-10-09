// SPDX-License-Identifier: Apache-2.0
// Changing the spec of a single task after the work on it has started, with the fake agent CLI.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateTaskInput } from '@harnessboard/shared';
import { ClaudeCodeAdapter } from '../src/claude-code.js';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
  assistantText,
  exitWith,
  init,
  makeRepo,
  rateLimit,
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
  dir = tempDir('spec-change');
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

const SPEC = 'docs/specs/001-add-a-greeting.md';
const session = (reply: string) => [[init(), assistantText(reply, 10_000), result(reply)]];
const discussion = session('I read main.js.\n## Acceptance criteria\n- prints hi');
const specFile = [[init(), writeFile(SPEC, '# Spec\n'), result('spec written')]];
const REVISED = '## Changes\n- Hello, not hi.\n## Acceptance criteria\n- prints hello';
const PROPOSING =
  'Built most of it.\nSPEC CHANGE: hi is too short\n- prints hello\n## Notes\n- stopped early';

async function runQueued(): Promise<void> {
  harness.tick();
  await harness.waitForIdle();
}

const status = (id: number) => harness.store.getTask(id)!.status;
const worktree = (id: number) => harness.store.getTask(id)!.worktreePath!;
const committedSpec = (id: number) =>
  execFileSync('git', ['show', `HEAD:${SPEC}`], { cwd: worktree(id), encoding: 'utf8' });
const lastCommitMessage = (id: number) =>
  execFileSync('git', ['log', '-1', '--format=%s'], { cwd: worktree(id), encoding: 'utf8' }).trim();

/** A task whose criteria were agreed and whose spec file was written; `later` runs after. */
async function specced(later: unknown[][][], extra: Partial<CreateTaskInput> = {}) {
  scenario(discussion, specFile, ...later);
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
  await runQueued();
  return task;
}

describe('a spec change the user asks for while the task is in review', () => {
  async function asked() {
    const task = await specced([session('done'), session(REVISED)]);
    harness.requestSpecRevision(task.id, 'Say hello instead');
    await harness.waitForIdle();
    return task;
  }

  it('returns the task to waiting for approval', async () => {
    const task = await asked();
    expect(status(task.id)).toBe('awaiting_approval');
  });

  it('is answered by the spec author in a read-only session', async () => {
    const task = await asked();
    const sessions = harness.store.listSessions(task.id);
    const args = fakeRuns()[3]!.args;
    expect([
      sessions.at(-1)!.role,
      args.includes('--dangerously-skip-permissions'),
      args.includes('acceptEdits'),
    ]).toEqual(['spec', false, false]);
  });

  it("gives the spec author the user's message and the spec file", async () => {
    await asked();
    const prompt = fakeRuns()[3]!.received[0]!;
    expect([prompt.includes('Say hello instead'), prompt.includes(SPEC)]).toEqual([true, true]);
  });

  it('records the revised proposal next to the criteria in force', async () => {
    const task = await asked();
    expect(harness.specChange(task.id)).toEqual({
      from: 'user',
      reason: 'Say hello instead',
      previous: '- prints hi',
      criteria: '- prints hello',
      reply: REVISED,
      onReject: 'review',
      sessionId: harness.store.listSessions(task.id).at(-1)!.id,
      requestId: harness.store.lastEvent(task.id, 'spec_revision')!.id,
    });
  });

  it('leaves the criteria as they are until the user decides', async () => {
    const task = await asked();
    expect(harness.store.getTask(task.id)!.acceptance).toBe('- prints hi');
  });

  it('is refused for a task without a spec file', async () => {
    const task = await harness.createTask({ prompt: 'x', repo, acceptance: '- a', reviewer: null });
    expect(() => harness.requestSpecRevision(task.id, 'change it')).toThrow(/no spec file/);
  });

  it('is refused without a message', async () => {
    const task = await specced([session('done')]);
    expect(() => harness.requestSpecRevision(task.id, '  ')).toThrow(/what should change/);
  });
});

describe('a spec change the user asks for while a session runs', () => {
  it('is answered once the session has ended', async () => {
    scenario(discussion, specFile, session('done'), session(REVISED));
    const task = await harness.createTask({
      prompt: 'Add a greeting',
      repo,
      queue: true,
      reviewer: null,
    });
    await harness.waitForIdle();
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    // Asked the moment the implementer's session is under way.
    const stop = harness.subscribe((event) => {
      if (event.type !== 'task' || event.status !== 'running') return;
      stop();
      harness.requestSpecRevision(task.id, 'Say hello instead');
    });
    await runQueued();
    await runQueued();
    expect([status(task.id), harness.specChange(task.id)?.onReject]).toEqual([
      'awaiting_approval',
      'review',
    ]);
  });
});

describe('approving a spec change the user asked for', () => {
  async function approved() {
    const task = await specced([session('done'), session(REVISED), session('adapted')]);
    harness.requestSpecRevision(task.id, 'Say hello instead');
    await harness.waitForIdle();
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    await runQueued();
    return task;
  }

  it('makes the revised criteria the task’s', async () => {
    const task = await approved();
    expect(harness.store.getTask(task.id)!.acceptance).toBe('- prints hello');
  });

  it('writes the revised criteria into the spec file', async () => {
    const task = await approved();
    expect(committedSpec(task.id)).toContain('## Acceptance criteria\n\n- prints hello\n');
  });

  it('adds a dated Revisions entry to the spec file', async () => {
    const task = await approved();
    expect(committedSpec(task.id)).toMatch(
      /^## Revisions\n\n- \d{4}-\d{2}-\d{2}: acceptance criteria changed at the user's request: Say hello instead\n$/m,
    );
  });

  it('commits the spec file', async () => {
    const task = await approved();
    expect(lastCommitMessage(task.id)).toBe('docs: revise task specification');
  });

  it('leaves the spec file without uncommitted changes', async () => {
    const task = await approved();
    expect(readFileSync(path.join(worktree(task.id), SPEC), 'utf8')).toBe(committedSpec(task.id));
  });

  it('resumes the implementer with the changed criteria', async () => {
    await approved();
    const run = fakeRuns()[4]!;
    expect([
      run.args.includes('--resume'),
      run.received[0]!.startsWith('[harness] The user approved a change to the spec.'),
      run.received[0]!.includes('- prints hello'),
    ]).toEqual([true, true, true]);
  });

  it('ends at review once the implementer is done', async () => {
    const task = await approved();
    expect(status(task.id)).toBe('review');
  });

  it('has the next review judge against the changed criteria', async () => {
    const task = await specced(
      [
        session('done'),
        session('VERDICT: APPROVE'),
        session(REVISED),
        session('adapted'),
        session('VERDICT: APPROVE'),
      ],
      { reviewer: 'claude' },
    );
    await runQueued(); // the first review
    harness.requestSpecRevision(task.id, 'Say hello instead');
    await harness.waitForIdle();
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    await runQueued();
    const prompt = fakeRuns()[6]!.received[0]!;
    expect([prompt.includes('- prints hello'), prompt.includes('- prints hi\n')]).toEqual([
      true,
      false,
    ]);
  });

  it('approves the criteria the user edited instead', async () => {
    const task = await specced([session('done'), session(REVISED), session('adapted')]);
    harness.requestSpecRevision(task.id, 'Say hello instead');
    await harness.waitForIdle();
    harness.approveSpecChange(task.id, '- prints hello world');
    await harness.waitForIdle();
    expect(harness.store.getTask(task.id)!.acceptance).toBe('- prints hello world');
  });
});

describe('rejecting a spec change the user asked for', () => {
  async function rejected() {
    const task = await specced([session('done'), session(REVISED)]);
    harness.requestSpecRevision(task.id, 'Say hello instead');
    await harness.waitForIdle();
    harness.rejectSpecChange(task.id);
    await harness.waitForIdle();
    return task;
  }

  it('returns the task to review, where it was', async () => {
    const task = await rejected();
    expect(status(task.id)).toBe('review');
  });

  it('leaves the spec file untouched', async () => {
    const task = await rejected();
    expect(committedSpec(task.id)).toBe('# Spec\n');
  });

  it('leaves the criteria untouched', async () => {
    const task = await rejected();
    expect(harness.store.getTask(task.id)!.acceptance).toBe('- prints hi');
  });

  it('no longer shows the change as waiting', async () => {
    const task = await rejected();
    expect(harness.specChange(task.id)).toBeNull();
  });
});

describe('replying to a proposed spec change', () => {
  it('asks the spec author again with the reply and the earlier proposal', async () => {
    const task = await specced([session('done'), session(REVISED), session(REVISED)]);
    harness.requestSpecRevision(task.id, 'Say hello instead');
    await harness.waitForIdle();
    harness.planFeedback(task.id, 'Capitalise it');
    await harness.waitForIdle();
    const prompt = fakeRuns()[4]!.received[0]!;
    expect([prompt.includes('Capitalise it'), prompt.includes('- prints hello')]).toEqual([
      true,
      true,
    ]);
  });
});

describe('a spec change the implementer proposes', () => {
  async function proposed(later: unknown[][][] = [], extra: Partial<CreateTaskInput> = {}) {
    return specced([session(PROPOSING), ...later], extra);
  }

  it('is offered the SPEC CHANGE block in its prompt', async () => {
    await proposed();
    expect(fakeRuns()[2]!.received[0]).toContain('SPEC CHANGE: <why, in one line>');
  });

  it('makes the task wait for the user', async () => {
    const task = await proposed();
    expect(status(task.id)).toBe('awaiting_approval');
  });

  it('records the reason and the revised criteria', async () => {
    const task = await proposed();
    expect(harness.specChange(task.id)).toEqual({
      from: 'implementer',
      reason: 'hi is too short',
      previous: '- prints hi',
      criteria: '- prints hello',
      reply: PROPOSING,
      onReject: 'queued',
      sessionId: null,
      requestId: null,
    });
  });

  it('builds nothing more until the user decides', async () => {
    await proposed([session('more')]);
    await runQueued();
    expect(fakeRuns()).toHaveLength(3);
  });

  it('is not sent for review until the user decides', async () => {
    const task = await proposed([], { reviewer: 'claude' });
    expect(harness.pendingReview(task.id)).toBeNull();
  });

  it('resumes the implementer with the changed criteria once approved', async () => {
    const task = await proposed([session('adapted')]);
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    const run = fakeRuns()[3]!;
    expect([run.args.includes('--resume'), run.received[0]!.includes('- prints hello')]).toEqual([
      true,
      true,
    ]);
  });

  it("notes in the spec file that the implementer's change was approved", async () => {
    const task = await proposed([session('adapted')]);
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    expect(committedSpec(task.id)).toContain(
      ': acceptance criteria changed as the implementer proposed, approved by the user: hi is too short\n',
    );
  });

  it('tells the implementer to go on as before once rejected', async () => {
    const task = await proposed([session('carried on')]);
    harness.rejectSpecChange(task.id);
    await harness.waitForIdle();
    expect(fakeRuns()[3]!.received[0]).toContain(
      '[harness] The user rejected your proposed change to the spec. The spec and its ' +
        'acceptance criteria stay as they are: continue the task against them.',
    );
  });

  it('leaves the spec file untouched once rejected', async () => {
    const task = await proposed([session('carried on')]);
    harness.rejectSpecChange(task.id);
    await harness.waitForIdle();
    expect(committedSpec(task.id)).toBe('# Spec\n');
  });

  it('continues the work to review once rejected', async () => {
    const task = await proposed([session('carried on')]);
    harness.rejectSpecChange(task.id);
    await harness.waitForIdle();
    expect(status(task.id)).toBe('review');
  });

  it('refuses a decision when no change is waiting', async () => {
    const task = await specced([session('done')]);
    expect(() => harness.rejectSpecChange(task.id)).toThrow(/no spec change waiting/);
  });
});

/**
 * Reopens the harness with a second profile for the spec author. With one profile the
 * implementer goes on in the spec author's conversation, which a chat does not continue.
 */
async function withSpecAuthor(): Promise<void> {
  await harness.shutdown();
  harness.store.close();
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'author'),
    agents: {
      claude: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null },
      author: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null },
    },
    fallbackContextWindow: 100_000,
  };
  harness = Harness.open(config);
}

describe('a decision on a spec change with a chat waiting to be sent', () => {
  beforeEach(withSpecAuthor);

  it('still tells the implementer the approved criteria after the chat', async () => {
    const task = await specced(
      [session('done'), session(REVISED), session('just chatting'), session('adapted')],
      { spec: 'author' },
    );
    harness.requestSpecRevision(task.id, 'Say hello instead');
    await harness.waitForIdle();
    harness.chat(task.id, 'How is it going?');
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    await runQueued();
    expect(fakeRuns()[5]!.received[0]).toContain(
      '[harness] The user approved a change to the spec.',
    );
  });

  it('still tells the implementer its own change was rejected after the chat', async () => {
    const task = await specced(
      [session(PROPOSING), session('just chatting'), session('carried on')],
      { spec: 'author' },
    );
    harness.chat(task.id, 'How is it going?');
    harness.rejectSpecChange(task.id);
    await harness.waitForIdle();
    await runQueued();
    expect(fakeRuns()[4]!.received[0]).toContain(
      '[harness] The user rejected your proposed change to the spec.',
    );
  });
});

describe('a second spec change request while the spec author answers the first', () => {
  const CAPITALISED = '## Changes\n- Capitalised.\n## Acceptance criteria\n- prints Hello';

  async function askedTwice() {
    const task = await specced([session('done'), session(REVISED), session(CAPITALISED)]);
    const stop = harness.subscribe((event) => {
      if (event.type !== 'task' || event.status !== 'running') return;
      stop();
      harness.requestSpecRevision(task.id, 'Capitalise it too');
    });
    harness.requestSpecRevision(task.id, 'Say hello instead');
    await harness.waitForIdle();
    await runQueued();
    return task;
  }

  it('records the first answer for the first request', async () => {
    const task = await askedTwice();
    const reasons = harness.store
      .eventsOfKind(task.id, 'spec_change')
      .map((e) => (e.data as { reason: string }).reason);
    expect(reasons).toEqual(['Say hello instead', 'Capitalise it too']);
  });

  it('asks the spec author about the second request, starting from the first answer', async () => {
    await askedTwice();
    const prompt = fakeRuns()[4]!.received[0]!;
    expect([prompt.includes('Capitalise it too'), prompt.includes('- prints hello')]).toEqual([
      true,
      true,
    ]);
  });

  it('waits for approval of the answer to the second request, returning to review if rejected', async () => {
    const task = await askedTwice();
    expect([
      status(task.id),
      harness.specChange(task.id)?.reason,
      harness.specChange(task.id)?.onReject,
    ]).toEqual(['awaiting_approval', 'Capitalise it too', 'review']);
  });
});

describe('a spec change the user asks for while chatting about a task in review', () => {
  beforeEach(withSpecAuthor);

  async function askedDuringChat() {
    const task = await specced([session('done'), session('chatted'), session(REVISED)], {
      spec: 'author',
    });
    harness.chat(task.id, 'Can you tidy it?');
    harness.requestSpecRevision(task.id, 'Say hello instead');
    await harness.waitForIdle();
    await runQueued();
    return task;
  }

  it('is answered by the spec author once the chat ends', async () => {
    const task = await askedDuringChat();
    expect([status(task.id), harness.specChange(task.id)?.reason]).toEqual([
      'awaiting_approval',
      'Say hello instead',
    ]);
  });

  it('returns the task to review when the change is rejected', async () => {
    const task = await askedDuringChat();
    harness.rejectSpecChange(task.id);
    expect(status(task.id)).toBe('review');
  });
});

describe('a newer spec change request after an earlier answer was cut off', () => {
  const IMPLEMENTED = [[init('impl'), assistantText('done', 10_000), result('done')]];
  const CUT_OFF = [
    [init('cut-off'), assistantText('reading', 10_000), { ...result('boom'), is_error: true }],
  ];

  it('resumes the implementer in its own conversation, not the cut-off answer', async () => {
    const task = await specced([IMPLEMENTED, CUT_OFF, session(REVISED), session('adapted')]);
    harness.requestSpecRevision(task.id, 'Say hi loudly');
    await harness.waitForIdle();
    harness.requestSpecRevision(task.id, 'Say hello instead');
    await harness.waitForIdle();
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    const args = fakeRuns()[5]!.args;
    expect(args[args.indexOf('--resume') + 1]).toBe('impl');
  });
});

describe('quota checks for a spec change with agents of different providers', () => {
  const FUTURE_SEC = Math.floor(Date.now() / 1000) + 3600;
  // The implementer's session uses up the Claude Code quota; the other profile is Codex's.
  const quotaSpent = [[init(), rateLimit('allowed', 0.97, FUTURE_SEC), result('done')]];

  beforeEach(async () => {
    await harness.shutdown();
    harness.store.close();
    const config = {
      ...defaultConfig({}),
      dataDir: path.join(dir, 'providers'),
      agents: {
        claude: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null },
        codex: { provider: 'codex' as const, command: FAKE_CLAUDE, model: null },
      },
      fallbackContextWindow: 100_000,
    };
    // Every profile runs the fake CLI; the quota checked comes from the profile's provider.
    harness = Harness.open(config, { adapterFactory: () => new ClaudeCodeAdapter(FAKE_CLAUDE) });
  });

  /** The user asks for a change while the implementer's step, which ends in review, runs. */
  async function askedDuringStep(later: unknown[][][], reviewer: string | null) {
    scenario(discussion, specFile, quotaSpent, ...later);
    const task = await harness.createTask({
      prompt: 'Add a greeting',
      repo,
      queue: true,
      reviewer,
      spec: 'codex',
    });
    await harness.waitForIdle();
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    const stop = harness.subscribe((event) => {
      if (event.type !== 'task' || event.status !== 'running') return;
      stop();
      harness.requestSpecRevision(task.id, 'Say hello instead');
    });
    await runQueued();
    await runQueued();
    return task;
  }

  it("answers the request when only the waiting reviewer's provider is out of quota", async () => {
    const task = await askedDuringStep([session(REVISED)], 'claude');
    expect(status(task.id)).toBe('awaiting_approval');
  });

  it('does not resume the implementer when only its own provider is out of quota', async () => {
    const task = await askedDuringStep([session(REVISED), session('adapted')], 'codex');
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    expect([status(task.id), fakeRuns().length]).toEqual(['queued', 4]);
  });

  it('still tells the implementer an approval made while it waited after a later request is rejected', async () => {
    const CAPITALISED = '## Changes\n- Capitalised.\n## Acceptance criteria\n- prints Hello';
    const task = await askedDuringStep(
      [session(REVISED), session(CAPITALISED), session('adapted')],
      null,
    );
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    harness.requestSpecRevision(task.id, 'Capitalise it too');
    await runQueued();
    harness.rejectSpecChange(task.id);
    await harness.waitForIdle();
    // The Claude Code quota is free again once the harness pauses only above 99 %.
    await harness.shutdown();
    harness = new Harness({ ...harness.config, quotaPauseUtilization: 0.99 }, harness.store, {
      adapterFactory: () => new ClaudeCodeAdapter(FAKE_CLAUDE),
    });
    await harness.start();
    await runQueued();
    const prompt = fakeRuns()[5]!.received[0]!;
    expect([
      prompt.includes('[harness] The user approved a change to the spec.'),
      prompt.includes('- prints hello'),
    ]).toEqual([true, true]);
  });
});

describe('a spec change decision given to an agent CLI that failed to start', () => {
  const FAILED = [[exitWith(1, 'could not start')]];

  it('is told again when the implementer is retried', async () => {
    const task = await specced([session(PROPOSING), FAILED, session('adapted')]);
    harness.approveCriteria(task.id);
    await harness.waitForIdle();
    harness.queueTask(task.id);
    await harness.waitForIdle();
    expect(fakeRuns()[4]!.received[0]).toContain(
      '[harness] The user approved a change to the spec.',
    );
  });

  describe('with two decisions waiting', () => {
    beforeEach(withSpecAuthor);

    async function retried() {
      const task = await specced(
        [
          session(PROPOSING),
          session('just chatting'),
          session(REVISED),
          FAILED,
          session('adapted'),
        ],
        { spec: 'author' },
      );
      harness.chat(task.id, 'How is it going?');
      harness.rejectSpecChange(task.id);
      await harness.waitForIdle();
      harness.requestSpecRevision(task.id, 'Say hello instead');
      await runQueued();
      harness.approveCriteria(task.id);
      await harness.waitForIdle();
      harness.queueTask(task.id);
      await harness.waitForIdle();
      return fakeRuns()[6]!.received[0]!;
    }

    it('tells the implementer its rejected proposal again', async () => {
      expect(await retried()).toContain(
        '[harness] The user rejected your proposed change to the spec.',
      );
    });

    it('tells the implementer the approved criteria again', async () => {
      expect(await retried()).toContain('[harness] The user approved a change to the spec.');
    });
  });
});
