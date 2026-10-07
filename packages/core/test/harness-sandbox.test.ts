// SPDX-License-Identifier: Apache-2.0
// A task whose agent profile runs in the Docker sandbox fails, instead of running the agent
// unsandboxed, when docker is missing. The PATH holds git but no docker.
import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { Harness } from '../src/harness.js';
import { FAKE_CLAUDE, init, makeRepo, result, tempDir, writeScenario } from './helpers.js';

let dir: string;
let repo: string;
let harness: Harness;

beforeEach(() => {
  dir = tempDir('sandbox-task');
  repo = makeRepo();
  process.env.FAKE_CLAUDE_LOG = path.join(dir, 'fake.log');
  process.env.FAKE_CLAUDE_SCENARIO = writeScenario(dir, [[[init(), result('done')]]]);
  const config = {
    ...defaultConfig({}),
    dataDir: path.join(dir, 'data'),
    agents: {
      claude: {
        provider: 'claude-code' as const,
        command: FAKE_CLAUDE,
        model: null,
        sandbox: 'docker' as const,
        sandboxImage: 'agents:1',
      },
    },
    fallbackContextWindow: 100_000,
  };
  harness = Harness.open(config);
  const bin = tempDir('git-only-path');
  const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  symlinkSync(git, path.join(bin, 'git'));
  vi.stubEnv('PATH', bin);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await harness.shutdown();
  harness.store.close();
});

async function runToEnd(): Promise<number> {
  const task = await harness.createTask({
    prompt: 'Add a greeting',
    repo,
    confirmPlan: false,
    reviewer: null,
    queue: true,
  });
  await harness.waitForIdle();
  return task.id;
}

// Linux and macOS only: on Windows the sandbox refuses before it looks for docker.
describe.skipIf(process.platform === 'win32')('a sandboxed task without docker', () => {
  it('fails', async () => {
    const id = await runToEnd();
    expect(harness.store.getTask(id)!.status).toBe('failed');
  });

  it('says docker was not found', async () => {
    const id = await runToEnd();
    const notice = harness.store.lastEvent(id, 'notice')!.data as { message: string };
    expect(notice.message).toBe(
      'task failed: the agent runs in a Docker sandbox, but docker was not found on PATH; ' +
        'it was not started',
    );
  });

  it('never runs the agent outside the sandbox', async () => {
    await runToEnd();
    expect(existsSync(process.env.FAKE_CLAUDE_LOG!)).toBe(false);
  });

  it('records no session', async () => {
    const id = await runToEnd();
    expect(harness.store.listSessions(id)).toEqual([]);
  });
});
