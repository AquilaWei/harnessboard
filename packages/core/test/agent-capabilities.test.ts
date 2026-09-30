// SPDX-License-Identifier: Apache-2.0
// A CLI without mid-turn input that assigns its own session ids (like Codex or Gemini).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
  PromptArgAdapter,
  assistantText,
  init,
  makeRepo,
  result,
  tempDir,
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
  dir = tempDir('caps');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: { claude: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null } },
    fallbackContextWindow: 100_000,
  };
  harness = Harness.open(config, { adapterFactory: (p) => new PromptArgAdapter(p.command) });
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

describe('a CLI that assigns its own session ids', () => {
  it('records the id it reports', async () => {
    scenario([[init('agent-7'), assistantText('done', 5_000), result('done')]]);
    const task = await harness.createTask({ prompt: 'Build it', repo, queue: true });
    await harness.waitForIdle();
    expect(harness.store.listSessions(task.id)[0]!.agentSessionId).toBe('agent-7');
  });

  it('passes the prompt as an argument', async () => {
    scenario([[init('agent-7'), result('done')]]);
    await harness.createTask({ prompt: 'Build it', repo, queue: true });
    await harness.waitForIdle();
    expect(fakeRuns()[0]!.args).toEqual(['--prompt', 'Build it']);
  });
});

describe('a CLI without mid-turn input crossing the soft threshold', () => {
  beforeEach(() => {
    scenario(
      [[init('agent-7'), assistantText('working', 45_000), result('part done')]],
      [[assistantText('STATUS: CONTINUE', 46_000), result('STATUS: CONTINUE\nhalf done')]],
    );
  });

  const create = () =>
    harness.createTask({ prompt: 'Build it', repo, softPct: 30, hardPct: 60, queue: true });

  it('asks for the wrap-up by resuming after the turn ends', async () => {
    await create();
    await harness.waitForIdle();
    const second = fakeRuns()[1]!;
    expect([second.args.slice(0, 2), second.received[0]]).toEqual([
      ['--resume', 'agent-7'],
      expect.stringContaining('Context usage has reached 45%'),
    ]);
  });

  it('hands off with the wrap-up reply as the note', async () => {
    const task = await create();
    await harness.waitForIdle();
    const note = harness.store.lastEvent(task.id, 'handoff')!.data as { note: string };
    expect(note.note).toBe('STATUS: CONTINUE\nhalf done');
  });
});
