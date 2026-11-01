// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { LocalAi } from '../src/localai.js';
import type { LocalAiConfig } from '../src/localai.js';
import { tempDir } from './helpers.js';

const FAKE_LOCALAI = fileURLToPath(new URL('./fixtures/fake-localai.mjs', import.meta.url));

const START = { type: 'start', data: {} };
const USAGE = {
  type: 'usage',
  data: { status: 'unavailable', prompt_tokens: null, completion_tokens: null },
};
const DONE = { type: 'done', data: { finish_reason: 'stop' } };
const answer = (text: string) => ({ type: 'delta', data: { channel: 'answer', text } });

let dir: string;

beforeEach(() => {
  dir = tempDir('localai');
  vi.stubEnv('FAKE_LOCALAI_LOG', path.join(dir, 'log.jsonl'));
});
afterEach(() => vi.unstubAllEnvs());

/** Writes a scenario for the fake binary and returns a client that runs it. */
function localAi(scenario: unknown, overrides: Partial<LocalAiConfig> = {}): LocalAi {
  const file = path.join(dir, 'scenario.json');
  writeFileSync(file, JSON.stringify(scenario));
  vi.stubEnv('FAKE_LOCALAI_SCENARIO', file);
  return new LocalAi({
    enabled: true,
    command: FAKE_LOCALAI,
    models: { pricing: 'gpt-oss-20b' },
    ...overrides,
  });
}

const request = { prompt: 'hello', timeoutMs: 10_000 };

function logged(): { args: string[]; stdin: string }[] {
  return readFileSync(path.join(dir, 'log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function isRunning(pidFile: string): boolean {
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 0);
    return true;
  } catch {
    return false;
  }
}

describe('LocalAi.run', () => {
  it('returns the answer and keeps reasoning separate on success', async () => {
    const ai = localAi({
      lines: [
        START,
        { type: 'delta', data: { channel: 'reasoning', text: 'think' } },
        answer('Hel'),
        answer('lo'),
        USAGE,
        DONE,
      ],
    });
    expect(await ai.run('pricing', request)).toEqual({
      status: 'ok',
      answer: 'Hello',
      reasoning: 'think',
    });
  });

  it('passes the prompt on stdin and selects the model with --model', async () => {
    const ai = localAi({ lines: [START, USAGE, DONE] });
    await ai.run('pricing', { ...request, prompt: '價目表' });
    expect(logged()).toEqual([
      { args: ['run', '--json', '--model', 'gpt-oss-20b'], stdin: '價目表' },
    ]);
  });

  it('uses the model configured for the use case', async () => {
    const ai = localAi({ lines: [START, USAGE, DONE] }, { models: { pricing: 'mellum2.1' } });
    await ai.run('pricing', request);
    expect(logged()[0]?.args).toEqual(['run', '--json', '--model', 'mellum2.1']);
  });

  it('accepts usage with null counts', async () => {
    const ai = localAi({ lines: [START, answer('x'), USAGE, DONE] });
    expect((await ai.run('pricing', request)).status).toBe('ok');
  });

  it('fails with the message of an error event and drops the partial answer', async () => {
    const ai = localAi({
      lines: [START, answer('par'), { type: 'error', data: { message: 'context too long' } }],
      exitCode: 2,
    });
    expect(await ai.run('pricing', request)).toEqual({
      status: 'failed',
      reason: 'context too long',
    });
  });

  it('fails when stdout ends without a terminal event', async () => {
    const ai = localAi({ lines: [START, answer('par')], stderr: 'killed' });
    expect(await ai.run('pricing', request)).toEqual({
      status: 'failed',
      reason: 'localai ended without a final event (exit 0): killed',
    });
  });

  it('fails when done is not preceded by usage', async () => {
    const ai = localAi({ lines: [START, answer('x'), DONE] });
    expect(await ai.run('pricing', request)).toEqual({
      status: 'failed',
      reason: 'localai finished without a usage event',
    });
  });

  it('fails on a non-zero exit code even after done', async () => {
    const ai = localAi({ lines: [START, answer('x'), USAGE, DONE], exitCode: 2 });
    expect(await ai.run('pricing', request)).toEqual({
      status: 'failed',
      reason: 'localai exited with code 2',
    });
  });

  it('fails on a protocol version other than 1', async () => {
    const ai = localAi({ lines: [{ ...START, version: 2 }] });
    expect(await ai.run('pricing', request)).toEqual({
      status: 'failed',
      reason: 'localai protocol version 2 is not supported (need 1)',
    });
  });

  it('fails when request_id changes during the run', async () => {
    const ai = localAi({ lines: [START, { ...answer('x'), request_id: 'b'.repeat(32) }] });
    expect(await ai.run('pricing', request)).toEqual({
      status: 'failed',
      reason: 'localai request_id changed during the run',
    });
  });

  it('fails on a line that is not JSON', async () => {
    const ai = localAi({ lines: [START, 'not json'] });
    expect(await ai.run('pricing', request)).toEqual({
      status: 'failed',
      reason: 'localai printed a line that is not JSON',
    });
  });

  it('fails when an event arrives before start', async () => {
    const ai = localAi({ lines: [answer('x'), START, USAGE, DONE] });
    expect(await ai.run('pricing', request)).toEqual({
      status: 'failed',
      reason: 'localai sent delta before start',
    });
  });

  it('fails when an event follows the terminal event', async () => {
    const ai = localAi({ lines: [START, USAGE, DONE, answer('late')] });
    expect(await ai.run('pricing', request)).toEqual({
      status: 'failed',
      reason: 'localai sent delta after the final event',
    });
  });

  it('kills the child and fails on timeout', async () => {
    const pidFile = path.join(dir, 'pid');
    const ai = localAi({ lines: [START, answer('x')], hang: true, pidFile });
    const result = await ai.run('pricing', { ...request, timeoutMs: 400 });
    expect(result).toEqual({ status: 'failed', reason: 'timed out after 400 ms' });
    expect(isRunning(pidFile)).toBe(false);
  });

  it('kills the child and fails when the signal aborts', async () => {
    const pidFile = path.join(dir, 'pid');
    const ai = localAi({ lines: [START, answer('x')], hang: true, pidFile });
    const controller = new AbortController();
    const running = ai.run('pricing', { ...request, signal: controller.signal });
    setTimeout(() => controller.abort(), 400);
    expect(await running).toEqual({ status: 'failed', reason: 'cancelled' });
    expect(isRunning(pidFile)).toBe(false);
  });

  it('does not start a process when the signal is already aborted', async () => {
    const ai = localAi({ lines: [START, USAGE, DONE] });
    const result = await ai.run('pricing', { ...request, signal: AbortSignal.abort() });
    expect(result).toEqual({ status: 'failed', reason: 'cancelled' });
  });

  it('runs queued requests one after another', async () => {
    const ai = localAi({ lines: [START, answer('x'), USAGE, DONE] });
    const results = await Promise.all([ai.run('pricing', request), ai.run('pricing', request)]);
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(logged()).toHaveLength(2);
  });
});

describe('LocalAi availability', () => {
  it('reports unavailable when the binary is missing', async () => {
    const ai = localAi({}, { command: path.join(dir, 'no-such-localai') });
    expect(await ai.run('pricing', request)).toEqual({
      status: 'unavailable',
      reason: `the "${path.join(dir, 'no-such-localai')}" binary was not found (install LocalAICLI or set localAi.command)`,
    });
  });

  it('reports unavailable when local AI is disabled, without starting the binary', async () => {
    const ai = localAi({ lines: [START, USAGE, DONE] }, { enabled: false });
    expect(await ai.run('pricing', request)).toEqual({
      status: 'unavailable',
      reason: 'local AI is disabled (set localAi.enabled in the config)',
    });
  });

  it('reports unavailable when localai is not on PATH and no command is configured', () => {
    const ai = localAi({}, { command: null });
    expect(ai.unavailableReason({ PATH: path.dirname(FAKE_LOCALAI) })).toBe(
      'the "localai" binary was not found (install LocalAICLI or set localAi.command)',
    );
  });

  it('is available when the configured binary exists', () => {
    expect(localAi({}).unavailableReason()).toBeNull();
  });
});

describe('localAi config', () => {
  const missing = () => path.join(tempDir('cfg'), 'none.json');

  it('is disabled with the gpt-oss-20b pricing model by default', () => {
    expect(loadConfig({ env: {}, configFile: missing() }).localAi).toEqual({
      enabled: false,
      command: null,
      models: { pricing: 'gpt-oss-20b' },
    });
  });

  it('keeps the default models when the file only enables local AI', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    writeFileSync(file, JSON.stringify({ localAi: { enabled: true } }));
    expect(loadConfig({ env: {}, configFile: file }).localAi).toEqual({
      enabled: true,
      command: null,
      models: { pricing: 'gpt-oss-20b' },
    });
  });

  it('rejects an empty model name', () => {
    const file = path.join(tempDir('cfg'), 'config.json');
    writeFileSync(file, JSON.stringify({ localAi: { models: { pricing: '' } } }));
    expect(() => loadConfig({ env: {}, configFile: file })).toThrow(
      'config localAi.models.pricing must be a model name',
    );
  });
});
