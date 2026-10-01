// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/claude-code.js';
import {
  askBash,
  assistantText,
  errorResult,
  init,
  rateLimit,
  result,
  usageResult,
} from './helpers.js';

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
          fiveHourResetsAt: 1790718000000,
          sevenDayResetsAt: null,
          resetsAt: 1790718000000,
        },
      },
    ]);
  });

  it('keeps each window its own reset time when the weekly window is limiting', () => {
    const line = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 1790812800,
        rateLimitType: 'seven_day',
        unifiedWindows: {
          five_hour: { utilization: 0.5, resetsAt: 1790718000 },
          seven_day: { utilization: 0.9, resetsAt: 1790812800 },
        },
      },
    };
    expect(parse(line)).toEqual([
      {
        kind: 'quota',
        quota: {
          status: 'allowed',
          fiveHourUtilization: 0.5,
          sevenDayUtilization: 0.9,
          fiveHourResetsAt: 1790718000000,
          sevenDayResetsAt: 1790812800000,
          resetsAt: 1790812800000,
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
        usage: null,
      },
    ]);
  });

  it("takes the conversation's tokens and cost from a result", () => {
    expect(parse(usageResult('done', 30, 131, 0.03))[0]).toMatchObject({
      usage: {
        costUsd: 0.03,
        models: {
          'test-model': { input: 30, output: 131, cacheRead: 0, cacheWrite: 0, costUsd: 0.03 },
        },
      },
    });
  });

  it('keeps the API error status of a failed result', () => {
    expect(parse(errorResult(429))).toEqual([
      {
        kind: 'result',
        isError: true,
        text: 'usage limit reached',
        apiErrorStatus: 429,
        contextWindow: null,
        usage: null,
      },
    ]);
  });

  it('ignores lines that are not JSON', () => {
    expect(adapter.parseLine('warning: something')).toEqual([]);
  });
});

describe('ClaudeCodeAdapter permission requests', () => {
  it('reads a can_use_tool request with the suggested rule', () => {
    expect(parse(askBash('r1', 'git add a.txt', 'git add *'))).toEqual([
      {
        kind: 'permission_request',
        requestId: 'r1',
        toolName: 'Bash',
        summary: 'git add a.txt',
        input: { command: 'git add a.txt' },
        suggestedRules: ['Bash(git add *)'],
      },
    ]);
  });

  it('allows by echoing the original input', () => {
    const [request] = parse(askBash('r1', 'git add a.txt', 'git add *'));
    const reply = adapter.encodePermissionReply(request as never, { behavior: 'allow' });
    expect(JSON.parse(reply)).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'r1',
        response: { behavior: 'allow', updatedInput: { command: 'git add a.txt' } },
      },
    });
  });

  it("denies with the user's reason", () => {
    const [request] = parse(askBash('r1', 'rm -rf build', 'rm *'));
    const reply = adapter.encodePermissionReply(request as never, {
      behavior: 'deny',
      message: 'use the clean task instead',
    });
    expect(JSON.parse(reply).response.response).toEqual({
      behavior: 'deny',
      message: 'use the clean task instead',
    });
  });
});

describe('ClaudeCodeAdapter.buildArgs', () => {
  const spec = {
    cwd: '/w',
    sessionId: 'id-1',
    resume: false,
    prompt: 'do it',
    model: null,
    access: 'edit' as const,
    allowedTools: ['Bash(git add *)'],
    skipPermissions: false,
    askPermission: false,
  };

  it('asks the harness about other tools when askPermission is set', () => {
    expect(adapter.buildArgs({ ...spec, askPermission: true }).slice(-2)).toEqual([
      '--permission-prompt-tool',
      'stdio',
    ]);
  });

  it('never asks when skipPermissions is set', () => {
    expect(
      adapter.buildArgs({ ...spec, askPermission: true, skipPermissions: true }),
    ).not.toContain('--permission-prompt-tool');
  });

  it('never asks in a read-only session', () => {
    expect(adapter.buildArgs({ ...spec, access: 'readOnly', askPermission: true })).not.toContain(
      '--permission-prompt-tool',
    );
  });

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

  it('limits a read-only session to inspection tools, ignoring skipPermissions', () => {
    const readOnly = { ...spec, access: 'readOnly' as const, allowedTools: [] };
    expect(adapter.buildArgs({ ...readOnly, skipPermissions: true })).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--session-id',
      'id-1',
      '--allowedTools',
      'Read',
      'Grep',
      'Glob',
      'Bash(git diff *)',
      'Bash(git log *)',
      'Bash(git show *)',
      'Bash(git status)',
    ]);
  });

  it('adds extra checks for a read-only session after the inspection tools', () => {
    const readOnly = { ...spec, access: 'readOnly' as const, allowedTools: ['Bash(npm test)'] };
    expect(adapter.buildArgs(readOnly).at(-1)).toBe('Bash(npm test)');
  });
});
