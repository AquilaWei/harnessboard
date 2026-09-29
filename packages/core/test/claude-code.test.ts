// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/claude-code.js';
import { assistantText, errorResult, init, rateLimit, result } from './helpers.js';

const adapter = new ClaudeCodeAdapter('claude');
const parse = (obj: unknown) => adapter.parseLine(JSON.stringify(obj));

describe('ClaudeCodeAdapter.parseLine', () => {
  it('reads session id and model from init', () => {
    expect(parse(init('abc'))).toEqual([{ kind: 'init', sessionId: 'abc', model: 'test-model' }]);
  });

  it('reports context as input plus cache read plus cache creation tokens', () => {
    const line = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [],
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 8257,
          cache_creation_input_tokens: 17429,
        },
      },
    };
    expect(parse(line)).toEqual([{ kind: 'context', tokens: 25688 }]);
  });

  it('ignores usage from sub-agent messages', () => {
    const line = { ...assistantText('hi', 5000), parent_tool_use_id: 'toolu_1' };
    expect(parse(line)).toEqual([{ kind: 'text', text: 'hi' }]);
  });

  it('summarises a Bash tool call by its command', () => {
    const line = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
    };
    expect(parse(line)).toEqual([{ kind: 'tool_use', name: 'Bash', summary: 'npm test' }]);
  });

  it('converts quota reset time from seconds to milliseconds', () => {
    expect(parse(rateLimit('allowed', 0.5, 1790718000))).toEqual([
      {
        kind: 'quota',
        quota: {
          status: 'allowed',
          fiveHourUtilization: 0.5,
          sevenDayUtilization: null,
          resetsAt: 1790718000000,
        },
      },
    ]);
  });

  it('takes the context window from result modelUsage', () => {
    expect(parse(result('done', 1_000_000))).toEqual([
      {
        kind: 'result',
        isError: false,
        text: 'done',
        apiErrorStatus: null,
        contextWindow: 1_000_000,
      },
    ]);
  });

  it('keeps the API error status of a failed result', () => {
    expect(parse(errorResult(429))).toEqual([
      {
        kind: 'result',
        isError: true,
        text: 'usage limit reached',
        apiErrorStatus: 429,
        contextWindow: null,
      },
    ]);
  });

  it('ignores lines that are not JSON', () => {
    expect(adapter.parseLine('warning: something')).toEqual([]);
  });
});

describe('ClaudeCodeAdapter.buildArgs', () => {
  const spec = {
    cwd: '/w',
    sessionId: 'id-1',
    resume: false,
    model: null,
    allowedTools: ['Bash(git add *)'],
    skipPermissions: false,
  };

  it('starts a new session with acceptEdits and the allowed tools', () => {
    expect(adapter.buildArgs(spec)).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--session-id',
      'id-1',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Bash(git add *)',
    ]);
  });

  it('resumes an existing session with --resume', () => {
    expect(adapter.buildArgs({ ...spec, resume: true })).toContain('--resume');
  });

  it('skips permission flags only when skipPermissions is set', () => {
    expect(adapter.buildArgs({ ...spec, skipPermissions: true })).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--session-id',
      'id-1',
      '--dangerously-skip-permissions',
    ]);
  });
});
