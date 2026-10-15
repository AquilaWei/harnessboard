// SPDX-License-Identifier: Apache-2.0
// A conversation that goes on hears what it was already told only once: standing rules,
// loop steps, notes and the feature list are not sent again every turn.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMIT_RULE } from '../src/commit-check.js';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { QUOTA_RESUME_PROMPT } from '../src/prompts.js';
import {
  FAKE_CLAUDE,
  assistantText,
  commitAll,
  compactBoundary,
  createHistoricalTask,
  errorResult,
  featureList,
  init,
  makeRepo,
  rateLimit,
  result,
  tempDir,
  writeScenario,
} from './helpers.js';

const FUTURE_SEC = Math.floor(Date.now() / 1000) + 3600;
let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('prompt-repeat');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  harness = Harness.open({
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: {
      claude: { provider: 'claude-code', command: FAKE_CLAUDE, model: null },
      qa: { provider: 'claude-code', command: FAKE_CLAUDE, model: null },
      checker: { provider: 'claude-code', command: FAKE_CLAUDE, model: null },
    },
    fallbackContextWindow: 100_000,
  });
});

afterEach(async () => {
  await harness.shutdown();
  harness.store.close();
});

const turn = (id: string, text: string, ...actions: unknown[]) => [
  [init(id), ...actions, assistantText(text, 10_000), result(text)],
];

/** The first message of every agent run, in order. */
function prompts(): string[] {
  return readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { received: string[] }).received[0]!);
}

async function runAll(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    harness.tick();
    await harness.waitForIdle();
  }
}

async function loopTask(tester: string | null = null) {
  const task = await createHistoricalTask(harness, {
    prompt: 'Build two features',
    repo,
    mode: 'loop',
    confirmPlan: false,
    verifyCommand: 'node -e "process.exit(0)"',
    reviewer: 'checker',
    tester,
    queue: true,
  });
  await runAll();
  return task;
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;

describe('an implementer that goes on to the next feature in its own conversation', () => {
  beforeEach(() => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'planned', featureList(false, false), commitAll('docs: plan')),
      turn('worker', 'F1 done', featureList(true, false), commitAll('feat: first')),
      turn('reviewer', 'VERDICT: APPROVE\n\n## Notes\nreviewer-note-one'),
      turn('worker', 'F2 done', featureList(true, true), commitAll('feat: second')),
      turn('reviewer', 'VERDICT: APPROVE'),
    ]);
  });

  it('gets the commit rule with its first prompt', async () => {
    await loopTask();
    expect(prompts()[0]).toContain(COMMIT_RULE);
  });

  it('is asked for a notes section with its first prompt', async () => {
    await loopTask();
    expect(prompts()[0]).toContain('End your reply with a `## Notes` section');
  });

  it('is not given the commit rule again', async () => {
    await loopTask();
    expect(prompts()[3]).not.toContain(COMMIT_RULE);
  });

  it('is not asked for a notes section again', async () => {
    await loopTask();
    expect(prompts()[3]).not.toContain('End your reply with a `## Notes` section');
  });

  it('gets a short reminder instead of the loop steps', async () => {
    await loopTask();
    expect(prompts()[3]).not.toContain('6. Stop after this one feature.');
  });

  it('gets the reviewer notes without the notes file header', async () => {
    await loopTask();
    expect(prompts()[3]).not.toContain('edits to it are lost');
  });

  it('still gets the reviewer notes written since its last turn', async () => {
    await loopTask();
    expect(prompts()[3]).toContain('reviewer-note-one');
  });
});

describe('an implementer whose conversation was compacted after its last feature', () => {
  it('is given the commit rule again', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'planned', featureList(false, false), commitAll('docs: plan')),
      turn(
        'worker',
        'F1 done',
        featureList(true, false),
        commitAll('feat: first'),
        compactBoundary(60_000, 8_000),
      ),
      turn('reviewer', 'VERDICT: APPROVE'),
      turn('worker', 'F2 done', featureList(true, true), commitAll('feat: second')),
      turn('reviewer', 'VERDICT: APPROVE'),
    ]);
    await loopTask();
    expect(prompts()[3]).toContain(COMMIT_RULE);
  });
});

describe('a reviewer in its second round', () => {
  beforeEach(() => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'planned', featureList(false, false), commitAll('docs: plan')),
      turn('worker', 'F1 done', featureList(true, false), commitAll('feat: first')),
      turn('reviewer', 'VERDICT: APPROVE'),
      turn('worker', 'F2 done', featureList(true, true), commitAll('feat: second')),
      turn('reviewer', 'VERDICT: APPROVE'),
    ]);
  });

  it('gets the newly done feature with its description', async () => {
    await loopTask();
    expect(prompts()[4]).toContain('- F2: feature 2');
  });

  it('gets a feature done before by its id only', async () => {
    await loopTask();
    expect(prompts()[4]).not.toContain('- F1: feature 1');
  });
});

describe('a reviewer that requests changes', () => {
  it('reaches the implementer with its notes only once', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'planned', featureList(false, false), commitAll('docs: plan')),
      turn('worker', 'F1 done', featureList(true, false), commitAll('feat: first')),
      turn('reviewer', 'VERDICT: CHANGES\n1. Fix a.ts\n\n## Notes\nreviewer-note-once'),
      turn('worker', 'fixed', commitAll('fix: a')),
      turn('reviewer', 'VERDICT: APPROVE'),
    ]);
    await loopTask();
    expect(occurrences(prompts()[3]!, 'reviewer-note-once')).toBe(1);
  });
});

describe('an implementer resumed twice in a row', () => {
  it('does not get the notes it was given the first time again', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'planned', featureList(false, false), commitAll('docs: plan')),
      turn('worker', 'F1 done', featureList(true, false), commitAll('feat: first')),
      turn('reviewer', 'VERDICT: APPROVE\n\n## Notes\nreviewer-note-first'),
      turn('worker', 'F2 done', featureList(true, true), commitAll('feat: second')),
      turn('reviewer', 'VERDICT: CHANGES\n1. Fix b.ts\n\n## Notes\nreviewer-note-second'),
      turn('worker', 'fixed', commitAll('fix: b')),
      turn('reviewer', 'VERDICT: APPROVE'),
    ]);
    await loopTask();
    expect(prompts()[5]).not.toContain('reviewer-note-first');
  });
});

describe('a tester', () => {
  beforeEach(() => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'planned', featureList(false, false), commitAll('docs: plan')),
      turn('worker', 'F1 done', featureList(true, false), commitAll('feat: first')),
      turn('tester', 'TESTS: PASS\n\n## Notes\ntester-note-one'),
      turn('reviewer', 'VERDICT: APPROVE'),
      turn('worker', 'F2 done', featureList(true, true), commitAll('feat: second')),
      turn('tester', 'TESTS: PASS\n\n## Notes\ntester-note-two'),
      turn('reviewer', 'VERDICT: APPROVE'),
    ]);
  });

  it('is not told to commit', async () => {
    await loopTask('qa');
    expect(prompts()[2]).not.toContain(COMMIT_RULE);
  });

  it("reaches the resumed reviewer with this round's notes", async () => {
    await loopTask('qa');
    expect(prompts()[6]).toContain('tester-note-two');
  });

  it("does not reach the resumed reviewer with the last round's notes again", async () => {
    await loopTask('qa');
    expect(prompts()[6]).not.toContain('tester-note-one');
  });

  it('is told to leave the files alone with its first prompt', async () => {
    await loopTask('qa');
    expect(prompts()[2]).toContain('Do not write, change or commit any file');
  });

  it('is not told to leave the files alone again', async () => {
    await loopTask('qa');
    expect(prompts()[5]).not.toContain('Do not write, change or commit any file');
  });

  it('still gets its verdict line in a later round', async () => {
    await loopTask('qa');
    expect(prompts()[5]).toContain('Make the first line of your reply exactly `TESTS: PASS`');
  });
});

describe('a tester in its second round with features still to come', () => {
  it('is not told again not to request them', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'planned', featureList(false, false, false), commitAll('docs: plan')),
      turn('worker', 'F1 done', featureList(true, false, false), commitAll('feat: first')),
      turn('tester', 'TESTS: PASS'),
      turn('reviewer', 'VERDICT: APPROVE'),
      turn('worker', 'F2 done', featureList(true, true, false), commitAll('feat: second')),
      turn('tester', 'TESTS: PASS'),
      turn('reviewer', 'VERDICT: APPROVE'),
      turn('worker', 'F3 done', featureList(true, true, true), commitAll('feat: third')),
      turn('tester', 'TESTS: PASS'),
      turn('reviewer', 'VERDICT: APPROVE'),
    ]);
    await loopTask('qa');
    expect(prompts()[5]).not.toContain('hold their open questions against this step');
  });
});

describe('a reviewer resumed for its second round', () => {
  beforeEach(() => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'planned', featureList(false, false), commitAll('docs: plan')),
      turn('worker', 'F1 done', featureList(true, false), commitAll('feat: first')),
      turn('reviewer', 'VERDICT: APPROVE'),
      turn('worker', 'F2 done', featureList(true, true), commitAll('feat: second')),
      turn('reviewer', 'VERDICT: APPROVE'),
    ]);
  });

  it('is not told its test rule again', async () => {
    await loopTask();
    expect(prompts()[4]).not.toContain('A missing test the work needs');
  });

  it('is not told its review focus again', async () => {
    await loopTask();
    expect(prompts()[4]).not.toContain('Focus on architecture, logic and code rules');
  });
});

describe('a reviewer whose conversation was compacted after its first round', () => {
  it('is told its test rule again', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      turn('worker', 'planned', featureList(false, false), commitAll('docs: plan')),
      turn('worker', 'F1 done', featureList(true, false), commitAll('feat: first')),
      turn('reviewer', 'VERDICT: APPROVE', compactBoundary(60_000, 8_000)),
      turn('worker', 'F2 done', featureList(true, true), commitAll('feat: second')),
      turn('reviewer', 'VERDICT: APPROVE'),
    ]);
    await loopTask();
    expect(prompts()[4]).toContain('A missing test the work needs');
  });
});

describe('a session resumed after the usage limit reset', () => {
  it('is only told to continue', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [
      [
        [
          init('s1'),
          assistantText('working', 5_000),
          rateLimit('rejected', 1, FUTURE_SEC),
          errorResult(429),
        ],
      ],
      [[init('s1'), assistantText('resumed', 6_000), result('resumed')]],
    ]);
    await createHistoricalTask(harness, {
      prompt: 'Build it',
      repo,
      confirmPlan: false,
      queue: true,
    });
    await harness.waitForIdle();
    harness.tick(FUTURE_SEC * 1000 + 1);
    await harness.waitForIdle();
    expect(prompts()[1]).toBe(QUOTA_RESUME_PROMPT);
  });
});
