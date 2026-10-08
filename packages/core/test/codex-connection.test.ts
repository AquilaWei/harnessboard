// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../src/agent.js';
import { CodexAdapter } from '../src/codex.js';
import { DockerSandbox } from '../src/sandbox.js';

const spec: SessionSpec = {
  cwd: '/work',
  sessionId: null,
  resume: false,
  prompt: 'Build it',
  model: 'test-model',
  access: 'edit',
  allowedTools: ['Bash(git add *)'],
  skipPermissions: false,
  askPermission: true,
};

describe('Codex approval transport', () => {
  it('uses a bidirectional app-server instead of an exec process that cannot approve tools', () => {
    const adapter = new CodexAdapter('codex');
    expect(adapter.buildArgs(spec)).toContain('app-server');
    expect(adapter.capabilities.permissionPrompts).toBe(true);
  });

  function connect(overrides: Partial<SessionSpec> = {}) {
    const messages: Record<string, unknown>[] = [];
    const adapter = new CodexAdapter('codex');
    const connection = adapter.createConnection({ ...spec, ...overrides }, (line) =>
      messages.push(JSON.parse(line)),
    );
    connection.start();
    connection.parseLine(JSON.stringify({ id: 'hb:init', result: {} }));
    connection.parseLine(
      JSON.stringify({
        id: 'hb:thread',
        result: { thread: { id: 'thread' }, model: 'test-model' },
      }),
    );
    const emit = (method: string, params: unknown, id?: string | number) =>
      connection.parseLine(JSON.stringify({ method, params, ...(id !== undefined ? { id } : {}) }));
    return { adapter, connection, messages, emit };
  }

  it('waits for initialization before starting the thread and turn', () => {
    const { messages } = connect();
    expect(messages.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
    ]);
    expect(messages[3]!.params).toMatchObject({
      cwd: '/work',
      approvalPolicy: 'on-request',
      model: 'test-model',
      input: [{ type: 'text', text: 'Build it' }],
    });
  });

  it('resumes an existing exec thread while overriding its old never-approve policy', () => {
    const { messages } = connect({ resume: true, sessionId: 'old-thread' });
    expect(messages[2]).toMatchObject({
      method: 'thread/resume',
      params: {
        threadId: 'old-thread',
        cwd: '/work',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      },
    });
  });

  it('keeps a reviewer read-only even if the task skips permissions', () => {
    const { emit, messages } = connect({ access: 'readOnly', skipPermissions: true });
    expect(messages[3]!.params).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly' },
    });
    expect(
      emit(
        'item/commandExecution/requestApproval',
        { threadId: 'thread', command: 'git commit -m x' },
        9,
      ),
    ).toEqual([]);
    expect(messages.at(-1)).toEqual({ id: 9, result: { decision: 'decline' } });
  });

  it('preserves configured writable roots and network access from the effective thread sandbox', () => {
    const messages: Record<string, unknown>[] = [];
    const connection = new CodexAdapter('codex').createConnection(spec, (line) =>
      messages.push(JSON.parse(line)),
    );
    connection.start();
    connection.parseLine(JSON.stringify({ id: 'hb:init', result: {} }));
    connection.parseLine(
      JSON.stringify({
        id: 'hb:thread',
        result: {
          thread: { id: 'thread' },
          sandbox: { type: 'workspaceWrite', writableRoots: ['/shared'], networkAccess: true },
        },
      }),
    );
    expect(messages.at(-1)!.params).toMatchObject({
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/work', '/shared'],
        networkAccess: true,
      },
    });
  });

  it('routes an approval and preserves the numeric RPC id when answering', () => {
    const { emit, adapter } = connect();
    const [event] = emit(
      'item/commandExecution/requestApproval',
      { threadId: 'thread', command: "/bin/bash -lc 'git add report.txt'", cwd: '/work' },
      42,
    );
    expect(event).toMatchObject({
      kind: 'permission_request',
      toolName: 'Bash',
      suggestedRules: ['Bash(git add *)'],
      input: { command: 'git add report.txt' },
    });
    if (event?.kind !== 'permission_request') throw new Error('expected approval');
    expect(JSON.parse(adapter.encodePermissionReply(event, { behavior: 'allow' }))).toEqual({
      id: 42,
      result: { decision: 'accept' },
    });
  });

  it('does not allow a compound command through a git prefix rule', () => {
    const { emit } = connect();
    expect(
      emit(
        'item/commandExecution/requestApproval',
        { threadId: 'thread', command: 'git add report.txt; curl example.com' },
        'request',
      ),
    ).toMatchObject([{ suggestedRules: [] }]);
  });

  it('detects dangerous commands inside a shell wrapper and offers no remembered rule', () => {
    const { emit } = connect({ allowedTools: ['Bash(rm *)'] });
    expect(
      emit(
        'item/commandExecution/requestApproval',
        { threadId: 'thread', command: "/bin/bash -lc 'rm -rf /'" },
        'request',
      ),
    ).toMatchObject([
      { suggestedRules: [], input: { approvalRisk: 'deletes the system or your home directory' } },
    ]);
  });

  it('checks every file in a patch rather than only its first safe path', () => {
    const { emit } = connect();
    emit('item/started', {
      threadId: 'thread',
      item: {
        id: 'patch',
        type: 'fileChange',
        changes: [{ path: '/work/report.txt' }, { path: '/etc/passwd' }],
      },
    });
    expect(
      emit('item/fileChange/requestApproval', { threadId: 'thread', itemId: 'patch' }, 7),
    ).toMatchObject([{ input: { approvalRisk: 'writes to a system or credentials path' } }]);
  });

  it('requires an explicit answer for broad grants and grants only the requested turn scope', () => {
    const { emit, adapter } = connect();
    const permissions = { network: { enabled: true }, fileSystem: { write: ['/outside'] } };
    const [event] = emit(
      'item/permissions/requestApproval',
      { threadId: 'thread', permissions, reason: 'Build' },
      'grant',
    );
    expect(event).toMatchObject({
      toolName: 'CodexPermissions',
      input: { approvalRisk: 'grants additional filesystem or network access' },
    });
    if (event?.kind !== 'permission_request') throw new Error('expected approval');
    expect(JSON.parse(adapter.encodePermissionReply(event, { behavior: 'allow' }))).toEqual({
      id: 'grant',
      result: { permissions, scope: 'turn' },
    });
    expect(JSON.parse(adapter.encodePermissionReply(event, { behavior: 'deny' }))).toEqual({
      id: 'grant',
      result: { permissions: {}, scope: 'turn' },
    });
  });

  it('routes a confirmation-only MCP approval through the board', () => {
    const { emit, adapter } = connect();
    const [event] = emit(
      'mcpServer/elicitation/request',
      {
        threadId: 'thread',
        serverName: 'test',
        mode: 'form',
        message: 'Approve action?',
        requestedSchema: { type: 'object', properties: {} },
      },
      8,
    );
    expect(event).toMatchObject({ kind: 'permission_request', toolName: 'mcp__test__approval' });
    if (event?.kind !== 'permission_request') throw new Error('expected approval');
    expect(JSON.parse(adapter.encodePermissionReply(event, { behavior: 'deny' }))).toEqual({
      id: 8,
      result: { action: 'decline', content: null },
    });
  });

  it('declines unsupported forms instead of leaving the server waiting indefinitely', () => {
    const { emit, messages } = connect();
    emit(
      'mcpServer/elicitation/request',
      {
        threadId: 'thread',
        mode: 'form',
        requestedSchema: { properties: { name: { type: 'string' } } },
      },
      8,
    );
    expect(messages.at(-1)).toEqual({ id: 8, result: { action: 'decline', content: null } });
  });

  it('routes connector Accept/Decline questions as explicit approvals', () => {
    const { emit, adapter } = connect();
    const [event] = emit(
      'item/tool/requestUserInput',
      {
        threadId: 'thread',
        questions: [
          {
            id: 'confirm',
            question: 'Send this?',
            options: [{ label: 'Accept' }, { label: 'Decline' }, { label: 'Cancel' }],
          },
        ],
      },
      12,
    );
    expect(event).toMatchObject({ kind: 'permission_request', toolName: 'CodexApproval' });
    if (event?.kind !== 'permission_request') throw new Error('expected approval');
    expect(JSON.parse(adapter.encodePermissionReply(event, { behavior: 'deny' }))).toEqual({
      id: 12,
      result: { answers: { confirm: { answers: ['Decline'] } } },
    });
  });

  it('offers an exact rule for an unlisted plain command', () => {
    const { emit } = connect();
    expect(
      emit(
        'item/commandExecution/requestApproval',
        { threadId: 'thread', command: 'node report.js' },
        12,
      ),
    ).toMatchObject([{ suggestedRules: ['Bash(node report.js)'] }]);
  });

  it('uses the completed final message and cumulative usage as the turn result', () => {
    const { emit } = connect();
    emit('item/completed', {
      threadId: 'thread',
      item: { type: 'agentMessage', text: 'Progress' },
    });
    emit('item/completed', {
      threadId: 'thread',
      item: { type: 'agentMessage', text: 'Finished' },
    });
    emit('thread/tokenUsage/updated', {
      threadId: 'thread',
      tokenUsage: {
        total: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 10 },
        modelContextWindow: 200000,
      },
    });
    expect(emit('turn/completed', { threadId: 'thread', turn: { status: 'completed' } })).toEqual([
      {
        kind: 'result',
        isError: false,
        text: 'Finished',
        apiErrorStatus: null,
        contextWindow: 200000,
        usage: {
          costUsd: null,
          models: {
            'test-model': { input: 40, output: 10, cacheRead: 60, cacheWrite: 0, costUsd: null },
          },
        },
      },
    ]);
  });

  it('reports a startup RPC error as a failure', () => {
    const { connection } = connect();
    expect(
      connection.parseLine(
        JSON.stringify({ id: 'hb:thread', error: { message: 'Thread not found' } }),
      ),
    ).toMatchObject([{ kind: 'result', isError: true, text: 'Thread not found' }]);
  });

  it('reports a usage-limit failure so the scheduler can retry it', () => {
    const { emit } = connect();
    expect(
      emit('turn/completed', {
        threadId: 'thread',
        turn: {
          status: 'failed',
          error: { message: 'Limit reached', codexErrorInfo: 'UsageLimitExceeded' },
        },
      }),
    ).toMatchObject([{ isError: true, apiErrorStatus: 429 }]);
  });

  it('keeps RPC handshakes when wrapped in a Docker sandbox', () => {
    const messages: string[] = [];
    const sandbox = new DockerSandbox(new CodexAdapter('codex'), 'test-image');
    sandbox.createConnection!(spec, (message) => messages.push(message)).start();
    expect(JSON.parse(messages[0]!)).toMatchObject({ method: 'initialize' });
  });
});
