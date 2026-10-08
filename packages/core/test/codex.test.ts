// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@harnessboard/shared';
import type { SessionSpec } from '../src/agent.js';
import { CodexAdapter } from '../src/codex.js';

const adapter = new CodexAdapter('codex');

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

describe('CodexAdapter.parseLine', () => {
  it('reads the thread id from thread.started as the session id', () => {
    expect(run([{ type: 'thread.started', thread_id: 'abc' }])).toEqual([
      { kind: 'init', sessionId: 'abc', model: 'codex' },
    ]);
  });

  it('reports the last agent message as the result text of the turn', () => {
    const events = run([
      { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'VERDICT: APPROVE' } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 },
      },
    ]);
    expect(events.at(-1)).toEqual({
      kind: 'result',
      isError: false,
      text: 'VERDICT: APPROVE',
      apiErrorStatus: null,
      contextWindow: null,
      usage: {
        costUsd: null,
        models: { codex: { input: 60, output: 7, cacheRead: 40, cacheWrite: 0, costUsd: null } },
      },
    });
  });

  it('does not carry a message over to the next run', () => {
    run([{ type: 'item.completed', item: { type: 'agent_message', text: 'old' } }]);
    const events = run([{ type: 'turn.completed' }]);
    expect(events).toEqual([expect.objectContaining({ kind: 'result', text: '' })]);
  });

  it('reports a command once, when it starts', () => {
    const command = { type: 'command_execution', command: '/bin/bash -lc ls' };
    const events = run([
      { type: 'item.started', item: command },
      { type: 'item.completed', item: command },
    ]);
    expect(events).toEqual([{ kind: 'tool_use', name: 'Bash', summary: '/bin/bash -lc ls' }]);
  });

  it('reports a file change with its paths once it completes', () => {
    const events = run([
      {
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: 'a.ts' }, { path: 'b.ts' }] },
      },
    ]);
    expect(events).toEqual([{ kind: 'tool_use', name: 'Edit', summary: 'a.ts, b.ts' }]);
  });

  it('turns a failed turn into an error result with the API status and message', () => {
    const message = JSON.stringify({ type: 'error', status: 400, error: { message: 'bad model' } });
    expect(run([{ type: 'turn.failed', error: { message } }])).toEqual([
      {
        kind: 'result',
        isError: true,
        text: 'bad model',
        apiErrorStatus: 400,
        contextWindow: null,
        usage: null,
      },
    ]);
  });

  it('treats a usage-limit failure without a status as 429 so the task retries later', () => {
    const events = run([{ type: 'turn.failed', error: { message: 'You hit your usage limit.' } }]);
    expect(events).toEqual([expect.objectContaining({ isError: true, apiErrorStatus: 429 })]);
  });

  it('ignores non-JSON lines and the error event that precedes turn.failed', () => {
    expect(
      run(['Reading additional input from stdin...', { type: 'error', message: 'x' }]),
    ).toEqual([]);
  });
});

describe('CodexAdapter.buildArgs', () => {
  it('starts a sandboxed app-server with approvals routed to the harness', () => {
    expect(adapter.buildArgs(spec)).toEqual([
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'approval_policy="on-request"',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'approvals_reviewer="user"',
    ]);
  });

  it('runs reviewers in the read-only sandbox', () => {
    expect(adapter.buildArgs({ ...spec, access: 'readOnly', skipPermissions: true })).toContain(
      'sandbox_mode="read-only"',
    );
  });

  it('turns the sandbox off only for an edit session that skips permissions', () => {
    const args = adapter.buildArgs({ ...spec, skipPermissions: true });
    expect(args).toContain('sandbox_mode="danger-full-access"');
    expect(args).toContain('approval_policy="never"');
    expect(args).not.toContain('sandbox_mode="workspace-write"');
  });

  it('throws when asked to resume without a thread id', () => {
    expect(() => adapter.buildArgs({ ...spec, resume: true })).toThrow(/thread id/);
  });

  it('keeps prompts, thread ids and models in RPC messages rather than process arguments', () => {
    const args = adapter.buildArgs({ ...spec, resume: true, sessionId: 't1', model: 'gpt-x' });
    expect(args.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']);
    expect(args).not.toContain('gpt-x');
    expect(args).not.toContain('t1');
    expect(args).not.toContain('do it');
  });
});
