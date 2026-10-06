// SPDX-License-Identifier: Apache-2.0
// A Gemini reviewer runs in plan mode, which refuses shell commands, so the harness gives it
// the git output. The implementer is the fake Claude CLI; the reviewer is the fake Gemini CLI.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import {
  FAKE_CLAUDE,
  askBash,
  commitAll,
  hang,
  init,
  makeRepo,
  result,
  tempDir,
  writeFile,
  writeScenario,
} from './helpers.js';

const FAKE_GEMINI = fileURLToPath(new URL('./fixtures/fake-gemini.mjs', import.meta.url));

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('gemini-review');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'claude.log');
  process.env.FAKE_GEMINI_LOG = path.join(dir, 'gemini.log');
  const approve = path.join(dir, 'gemini.json');
  writeFileSync(
    approve,
    JSON.stringify({
      runs: [
        [
          { type: 'init', session_id: 'g-1', model: 'gemini-3-pro' },
          { type: 'message', role: 'assistant', content: 'VERDICT: APPROVE' },
          { type: 'result', status: 'success' },
        ],
      ],
    }),
  );
  process.env.FAKE_GEMINI_SCENARIO = approve;
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: {
      claude: { provider: 'claude-code' as const, command: FAKE_CLAUDE, model: null },
      gemini: { provider: 'gemini' as const, command: FAKE_GEMINI, model: null },
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

/** The prompt the fake Gemini CLI got on its first run, or `null` when it never ran. */
function geminiPrompt(): string | null {
  const file = process.env.FAKE_GEMINI_LOG!;
  if (!existsSync(file)) return null;
  const run = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]!) as { stdin: string };
  return run.stdin;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

async function waitForStatus(id: number, status: string): Promise<void> {
  while (harness.store.getTask(id)!.status !== status) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const ADD_WORLD = [
  init(),
  writeFile('world.txt', 'world\n'),
  commitAll('add world.txt'),
  result('ok'),
];
const ADD_BYE = [init(), writeFile('bye.txt', 'goodbye\n'), commitAll('add bye.txt'), result('ok')];

/**
 * Base task 1 commits hello.txt and is stopped; base task 2 commits world.txt and is done;
 * task 1 comes back, commits bye.txt and is reviewed by Gemini.
 */
async function geminiReviewAfterAnotherTask(): Promise<string> {
  scenario(
    [
      [
        init(),
        writeFile('hello.txt', 'hello from the first stretch\n'),
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
    reviewer: 'gemini',
    autoApprove: false,
    queue: true,
  });
  await waitForStatus(first.id, 'awaiting_permission');
  harness.stopTask(first.id);
  await harness.waitForIdle();
  const second = await harness.createTask({
    prompt: 'Another change',
    repo,
    workspace: 'base',
    confirmPlan: false,
    reviewer: null,
    queue: true,
  });
  await harness.waitForIdle();
  harness.completeTask(second.id);
  harness.queueTask(first.id);
  await harness.waitForIdle();
  harness.tick(); // the reviewer's session
  await harness.waitForIdle();
  return geminiPrompt()!;
}

describe('a Gemini review of a base task with an earlier stretch', () => {
  it('gets the patch of its current stretch', async () => {
    const prompt = await geminiReviewAfterAnotherTask();
    expect(prompt).toContain('+goodbye');
  });

  it('gets the patch of its earlier stretch', async () => {
    const prompt = await geminiReviewAfterAnotherTask();
    expect(prompt).toContain('+hello from the first stretch');
  });

  it('gets the commit log of its earlier stretch', async () => {
    const prompt = await geminiReviewAfterAnotherTask();
    const hello = git(repo, 'log', '--format=%h', '-1', '--', 'hello.txt');
    expect(prompt).toContain(`${hello} add hello.txt`);
  });

  it('does not get the other task’s changes', async () => {
    const prompt = await geminiReviewAfterAnotherTask();
    expect(prompt).not.toContain('+world');
  });
});

describe('a Gemini review', () => {
  /** Runs a task whose implementer commits hello.txt and that Gemini reviews; returns its id. */
  async function reviewedByGemini(): Promise<number> {
    scenario([
      [init(), writeFile('hello.txt', 'hi there\n'), commitAll('add hello.txt'), result('ok')],
    ]);
    const task = await harness.createTask({
      prompt: 'Add a greeting',
      repo,
      confirmPlan: false,
      reviewer: 'gemini',
      queue: true,
    });
    await harness.waitForIdle();
    harness.tick(); // the reviewer's session
    await harness.waitForIdle();
    return task.id;
  }

  /** The arguments the fake Gemini CLI got on its first run. */
  function geminiArgs(): string[] {
    const run = readFileSync(process.env.FAKE_GEMINI_LOG!, 'utf8').split('\n')[0]!;
    return (JSON.parse(run) as { args: string[] }).args;
  }

  it('may read the directory holding the evidence files', async () => {
    const id = await reviewedByGemini();
    const evidence = path.join(dir, 'data', 'evidence', String(id));
    const args = geminiArgs();
    expect(
      args.slice(args.indexOf('--include-directories'), args.indexOf('--include-directories') + 2),
    ).toEqual(['--include-directories', evidence]);
  });

  it('finds the whole patch in the evidence directory', async () => {
    const id = await reviewedByGemini();
    const patch = readFileSync(
      path.join(dir, 'data', 'evidence', String(id), 'current-diff.txt'),
      'utf8',
    );
    expect(patch).toContain('+hi there');
  });

  it('is given a policy that keeps it in plan mode', async () => {
    await reviewedByGemini();
    const args = geminiArgs();
    const policy = readFileSync(args[args.indexOf('--admin-policy') + 1]!, 'utf8');
    expect(policy).toContain('toolName = "exit_plan_mode"\ndecision = "deny"');
  });

  it('has its evidence removed with the task', async () => {
    const id = await reviewedByGemini();
    await harness.deleteTask(id);
    expect(existsSync(path.join(dir, 'data', 'evidence', String(id)))).toBe(false);
  });
});

describe('a Claude review', () => {
  it('gets the git commands without their output, since it can run them', async () => {
    scenario(
      [[init(), writeFile('hello.txt', 'hi there\n'), commitAll('add hello.txt'), result('ok')]],
      [[init(), result('VERDICT: APPROVE')]],
    );
    await harness.createTask({
      prompt: 'Add a greeting',
      repo,
      confirmPlan: false,
      reviewer: 'claude',
      queue: true,
    });
    await harness.waitForIdle();
    harness.tick(); // the reviewer's session
    await harness.waitForIdle();
    const runs = readFileSync(process.env.FAKE_CLAUDE_LOG!, 'utf8').trim().split('\n');
    const reviewer = JSON.parse(runs[1]!) as { received: string[] };
    expect(reviewer.received[0]).not.toContain('+hi there');
  });
});
