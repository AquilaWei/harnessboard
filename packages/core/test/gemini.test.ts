// SPDX-License-Identifier: Apache-2.0
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@harnessboard/shared';
import type { SessionSpec } from '../src/agent.js';
import { GeminiAdapter } from '../src/gemini.js';
import { runSession } from '../src/runner.js';
import { tempDir } from './helpers.js';

const FAKE_GEMINI = fileURLToPath(new URL('./fixtures/fake-gemini.mjs', import.meta.url));

/** No system policies, whatever the test machine has in Gemini's system policy folder. */
const adapter = new GeminiAdapter('gemini', tempDir('gemini-no-system-policies'));

/** Only reading and searching is allowed; as admin rules these outrank the user's allowances. */
const READ_ONLY_POLICY = `# Written by Harnessboard for read-only (reviewer) sessions.
[[rule]]
toolName = "*"
decision = "deny"
priority = 900
denyMessage = "This session is read-only: it may only read and search files."

[[rule]]
toolName = ["read_file", "read_many_files", "glob", "grep_search", "list_directory", "google_web_search"]
decision = "allow"
priority = 950
`;

function run(lines: unknown[]): AgentEvent[] {
  const parse = adapter.createParser();
  return lines.flatMap((l) => parse(typeof l === 'string' ? l : JSON.stringify(l)));
}

const spec: SessionSpec = {
  cwd: '/work',
  sessionId: null,
  resume: false,
  prompt: 'do it',
  model: null,
  access: 'edit',
  allowedTools: [],
  skipPermissions: false,
  askPermission: false,
};

describe('GeminiAdapter.buildArgs', () => {
  it('auto-approves only file edits for an edit session that keeps permission checks', () => {
    expect(adapter.buildArgs(spec)).toEqual([
      '--output-format',
      'stream-json',
      '--approval-mode',
      'auto_edit',
    ]);
  });

  it('approves every tool for an edit session that skips permissions', () => {
    expect(adapter.buildArgs({ ...spec, skipPermissions: true })).toEqual([
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
    ]);
  });

  it('runs a read-only session in plan mode even when it asks to skip permissions', () => {
    expect(adapter.buildArgs({ ...spec, access: 'readOnly', skipPermissions: true })).toEqual([
      '--output-format',
      'stream-json',
      '--approval-mode',
      'plan',
      '--admin-policy',
      expect.stringMatching(/read-only\.toml$/),
    ]);
  });

  it('gives a new read-only session a policy that allows only reading', () => {
    const args = adapter.buildArgs({ ...spec, access: 'readOnly' });
    const policy = readFileSync(args[args.indexOf('--admin-policy') + 1]!, 'utf8');
    expect(policy).toBe(READ_ONLY_POLICY);
  });

  it('gives a resumed read-only session the same policy', () => {
    const args = adapter.buildArgs({ ...spec, access: 'readOnly', sessionId: 'g-1', resume: true });
    const policy = readFileSync(args[args.indexOf('--admin-policy') + 1]!, 'utf8');
    expect(policy).toBe(READ_ONLY_POLICY);
  });

  it('writes the policy again when its file was cleaned away', () => {
    const first = adapter.buildArgs({ ...spec, access: 'readOnly' });
    rmSync(first[first.indexOf('--admin-policy') + 1]!);
    const args = adapter.buildArgs({ ...spec, access: 'readOnly' });
    expect(readFileSync(args[args.indexOf('--admin-policy') + 1]!, 'utf8')).toBe(READ_ONLY_POLICY);
  });

  it('refuses a read-only session when the machine has system policies', () => {
    const system = tempDir('gemini-system-policies');
    writeFileSync(path.join(system, 'company.toml'), '');
    const guarded = new GeminiAdapter('gemini', system);
    expect(() => guarded.buildArgs({ ...spec, access: 'readOnly' })).toThrow(
      /ignores --admin-policy/,
    );
  });

  it('starts a read-only session when the system policy folder holds no policy file', () => {
    const system = tempDir('gemini-system-policies');
    writeFileSync(path.join(system, 'README.md'), '');
    const guarded = new GeminiAdapter('gemini', system);
    expect(guarded.buildArgs({ ...spec, access: 'readOnly' })).toContain('--admin-policy');
  });

  it('starts an edit session when the machine has system policies', () => {
    const system = tempDir('gemini-system-policies');
    writeFileSync(path.join(system, 'company.toml'), '');
    const guarded = new GeminiAdapter('gemini', system);
    expect(guarded.buildArgs({ ...spec, skipPermissions: true })).toContain('yolo');
  });

  it('gives an edit session no admin policy', () => {
    expect(adapter.buildArgs({ ...spec, skipPermissions: true })).not.toContain('--admin-policy');
  });

  it('adds each readable directory to the workspace', () => {
    expect(
      adapter.buildArgs({ ...spec, access: 'readOnly', readableDirs: ['/evidence/7'] }),
    ).toEqual([
      '--output-format',
      'stream-json',
      '--approval-mode',
      'plan',
      '--admin-policy',
      expect.stringMatching(/read-only\.toml$/),
      '--include-directories',
      '/evidence/7',
    ]);
  });

  it('passes the model and resumes the session by its id', () => {
    expect(
      adapter.buildArgs({ ...spec, model: 'gemini-3-pro', sessionId: 'g-1', resume: true }),
    ).toEqual([
      '--output-format',
      'stream-json',
      '--approval-mode',
      'auto_edit',
      '--model',
      'gemini-3-pro',
      '--resume',
      'g-1',
    ]);
  });

  it('leaves a prompt that starts with a dash out of the arguments', () => {
    expect(adapter.buildArgs({ ...spec, prompt: '--help me' })).not.toContain('--help me');
  });

  it('sends the prompt unchanged on stdin', () => {
    expect(adapter.encodePrompt('--help me\nplease')).toBe('--help me\nplease');
  });

  it('refuses to resume without a session id', () => {
    expect(() => adapter.buildArgs({ ...spec, resume: true })).toThrow(
      'resuming a Gemini session needs its session id',
    );
  });

  it('does not pass Claude-style tool rules on', () => {
    expect(adapter.buildArgs({ ...spec, allowedTools: ['Bash(pnpm test)'] })).not.toContain(
      'Bash(pnpm test)',
    );
  });
});

describe('GeminiAdapter.interactiveResumeArgs', () => {
  it('reopens the session in the interactive UI', () => {
    expect(adapter.interactiveResumeArgs('g-1')).toEqual(['--resume', 'g-1']);
  });
});

describe('GeminiAdapter.configPaths', () => {
  // A sandboxed reviewer has to see the policy file its arguments name.
  it("includes the read-only policy's folder for a read-only session", () => {
    const args = adapter.buildArgs({ ...spec, access: 'readOnly' });
    const policy = args[args.indexOf('--admin-policy') + 1]!;
    expect(adapter.configPaths('readOnly')).toContain(path.dirname(policy));
  });

  it('has only the config folder for an edit session', () => {
    expect(adapter.configPaths('edit')).toHaveLength(1);
  });
});

describe('GeminiAdapter.createParser', () => {
  it('reads the session id and model from init', () => {
    expect(run([{ type: 'init', session_id: 'g-1', model: 'gemini-3-pro' }])).toEqual([
      { kind: 'init', sessionId: 'g-1', model: 'gemini-3-pro' },
    ]);
  });

  it('joins assistant chunks into one message that ends at a tool call', () => {
    const events = run([
      { type: 'message', role: 'assistant', content: 'Looking at ', delta: true },
      { type: 'message', role: 'assistant', content: 'the tests.', delta: true },
      {
        type: 'tool_use',
        tool_name: 'run_shell_command',
        tool_id: 't1',
        parameters: { command: 'pnpm test' },
      },
    ]);
    expect(events).toEqual([
      { kind: 'text', text: 'Looking at the tests.' },
      { kind: 'tool_use', name: 'run_shell_command', summary: 'pnpm test' },
    ]);
  });

  it('leaves the echoed user prompt and tool results out of the log', () => {
    const events = run([
      { type: 'message', role: 'user', content: 'do it' },
      { type: 'tool_result', tool_id: 't1', status: 'success', output: 'ok' },
    ]);
    expect(events).toEqual([]);
  });

  it('reports the last message as the result text, with tokens per model', () => {
    const events = run([
      { type: 'message', role: 'assistant', content: 'first' },
      { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { file_path: 'a' } },
      { type: 'message', role: 'assistant', content: 'VERDICT: ', delta: true },
      { type: 'message', role: 'assistant', content: 'APPROVE', delta: true },
      {
        type: 'result',
        status: 'success',
        stats: {
          total_tokens: 150,
          input_tokens: 140,
          output_tokens: 10,
          cached: 40,
          input: 100,
          duration_ms: 900,
          tool_calls: 1,
          models: {
            'gemini-3-pro': {
              total_tokens: 150,
              input_tokens: 140,
              output_tokens: 10,
              cached: 40,
              input: 100,
            },
          },
        },
      },
    ]);
    expect(events.slice(-2)).toEqual([
      { kind: 'text', text: 'VERDICT: APPROVE' },
      {
        kind: 'result',
        isError: false,
        text: 'VERDICT: APPROVE',
        apiErrorStatus: null,
        contextWindow: null,
        usage: {
          costUsd: null,
          models: {
            'gemini-3-pro': { input: 100, output: 10, cacheRead: 40, cacheWrite: 0, costUsd: null },
          },
        },
      },
    ]);
  });

  it('reports the run totals under gemini when no per-model stats are given', () => {
    const events = run([
      {
        type: 'result',
        status: 'success',
        stats: { input_tokens: 50, output_tokens: 5, cached: 20 },
      },
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        usage: {
          costUsd: null,
          models: { gemini: { input: 30, output: 5, cacheRead: 20, cacheWrite: 0, costUsd: null } },
        },
      }),
    ]);
  });

  it('reports a failed run with its error message', () => {
    const events = run([
      { type: 'result', status: 'error', error: { type: 'FatalError', message: 'bad key' } },
    ]);
    expect(events).toEqual([
      {
        kind: 'result',
        isError: true,
        text: 'bad key',
        apiErrorStatus: null,
        contextWindow: null,
        usage: null,
      },
    ]);
  });

  it('treats a quota error as 429 so the task waits and retries', () => {
    const events = run([
      {
        type: 'result',
        status: 'error',
        error: { type: 'TerminalQuotaError', message: 'You have exhausted your daily quota' },
      },
    ]);
    expect(events).toEqual([expect.objectContaining({ isError: true, apiErrorStatus: 429 })]);
  });

  it('falls back to the last error event when a failed result has no message', () => {
    const events = run([
      { type: 'error', severity: 'warning', message: 'slow network' },
      { type: 'error', severity: 'error', message: 'RESOURCE_EXHAUSTED' },
      { type: 'result', status: 'error' },
    ]);
    expect(events).toEqual([
      expect.objectContaining({ text: 'RESOURCE_EXHAUSTED', apiErrorStatus: 429 }),
    ]);
  });

  it('ignores lines that are not JSON', () => {
    expect(run(['Loaded cached credentials.'])).toEqual([]);
  });

  it('does not carry a message over to the next run', () => {
    run([{ type: 'message', role: 'assistant', content: 'old' }]);
    expect(run([{ type: 'result', status: 'success' }])).toEqual([
      expect.objectContaining({ kind: 'result', text: '' }),
    ]);
  });
});

describe('a session with the fake gemini CLI', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir('gemini');
    process.env.FAKE_GEMINI_LOG = path.join(dir, 'fake.log');
  });

  function scenario(...runs: unknown[][]): void {
    const file = path.join(dir, 'scenario.json');
    writeFileSync(file, JSON.stringify({ runs }));
    process.env.FAKE_GEMINI_SCENARIO = file;
  }

  function session(events: AgentEvent[], prompt = 'do it') {
    return runSession({
      adapter: new GeminiAdapter(FAKE_GEMINI),
      spec: { ...spec, cwd: dir, prompt },
      thresholds: { compactPct: null, softPct: 60, hardPct: 80 },
      contextWindow: 1_000_000,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      onNotice: () => {},
      onStderr: () => {},
    });
  }

  it('completes with the final reply and reports the session id', async () => {
    scenario([
      { type: 'init', session_id: 'g-7', model: 'gemini-3-pro' },
      { type: 'message', role: 'user', content: 'do it' },
      { type: 'message', role: 'assistant', content: 'Done.', delta: true },
      { type: 'result', status: 'success' },
    ]);
    const events: AgentEvent[] = [];
    const outcome = await session(events);
    expect(outcome).toEqual(expect.objectContaining({ reason: 'completed', finalText: 'Done.' }));
    expect(events[0]).toEqual({ kind: 'init', sessionId: 'g-7', model: 'gemini-3-pro' });
  });

  it('passes the prompt to the CLI on stdin', async () => {
    scenario([{ type: 'result', status: 'success' }]);
    await session([], 'build the thing');
    const logged = JSON.parse(readFileSync(process.env.FAKE_GEMINI_LOG!, 'utf8')) as {
      args: string[];
      stdin: string;
    };
    expect(logged).toEqual({
      args: ['--output-format', 'stream-json', '--approval-mode', 'auto_edit'],
      stdin: 'build the thing',
    });
  });

  it('pauses for quota when the CLI reports a usage limit', async () => {
    scenario([
      { type: 'init', session_id: 'g-7', model: 'gemini-3-pro' },
      { type: 'result', status: 'error', error: { message: 'Quota exceeded for model' } },
      { __exit: 1 },
    ]);
    const outcome = await session([]);
    expect(outcome.reason).toBe('quota');
  });

  it('reports an exit without a result as an error with the CLI stderr', async () => {
    scenario([{ __exit: 41, __stderr: 'Please set an Auth method' }]);
    const outcome = await session([]);
    expect(outcome).toEqual(
      expect.objectContaining({
        reason: 'error',
        detail: 'agent exited with code 41 before a result: Please set an Auth method',
      }),
    );
  });
});

// On Windows `gemini` is a `gemini.cmd` shim, run through cmd.exe, whose command line holds
// at most 8,191 characters; a prompt passed as an argument longer than that never arrives.
describe('a long prompt through the gemini.cmd shim', () => {
  const LONG_PROMPT = `review this\n${'x'.repeat(20_000)}\nend of prompt`;
  let dir: string;

  beforeEach(() => {
    dir = tempDir('gemini-shim');
    process.env.FAKE_GEMINI_LOG = path.join(dir, 'fake.log');
    const file = path.join(dir, 'scenario.json');
    writeFileSync(file, JSON.stringify({ runs: [[{ type: 'result', status: 'success' }]] }));
    process.env.FAKE_GEMINI_SCENARIO = file;
  });

  /** The shim npm installs on Windows; elsewhere the fake script itself. */
  function command(): string {
    if (process.platform !== 'win32') return FAKE_GEMINI;
    const shim = path.join(dir, 'gemini.cmd');
    writeFileSync(shim, `@node "${FAKE_GEMINI}" %*\r\n`);
    return shim;
  }

  function logged(): { args: string[]; stdin: string } {
    return JSON.parse(readFileSync(process.env.FAKE_GEMINI_LOG!, 'utf8')) as {
      args: string[];
      stdin: string;
    };
  }

  function session(sessionSpec: SessionSpec) {
    return runSession({
      adapter: new GeminiAdapter(command(), tempDir('gemini-no-system-policies')),
      spec: { ...sessionSpec, cwd: dir },
      thresholds: { compactPct: null, softPct: 60, hardPct: 80 },
      contextWindow: 1_000_000,
      signal: new AbortController().signal,
      onEvent: () => {},
      onNotice: () => {},
      onStderr: () => {},
    });
  }

  it('delivers the whole prompt to a new session', async () => {
    const outcome = await session({ ...spec, prompt: LONG_PROMPT });
    expect(outcome.reason).toBe('completed');
    expect(logged().stdin).toBe(LONG_PROMPT);
  });

  it('delivers the whole prompt to a resumed session', async () => {
    const outcome = await session({
      ...spec,
      access: 'readOnly',
      readableDirs: ['/evidence/7'],
      sessionId: 'g-7',
      resume: true,
      prompt: LONG_PROMPT,
    });
    expect(outcome.reason).toBe('completed');
    expect(logged()).toEqual({
      args: [
        '--output-format',
        'stream-json',
        '--approval-mode',
        'plan',
        '--admin-policy',
        expect.stringMatching(/read-only\.toml$/),
        '--include-directories',
        '/evidence/7',
        '--resume',
        'g-7',
      ],
      stdin: LONG_PROMPT,
    });
  });
});
