// SPDX-License-Identifier: Apache-2.0
import type { AgentEvent, RunUsage } from '@harnessboard/shared';
import { estimateCodexCost } from '@harnessboard/shared';
import type { AgentConnection, PermissionReply, SessionSpec } from './agent.js';
import { riskOf } from './risk.js';

type Fields = Record<string, unknown>;
type PermissionEvent = Extract<AgentEvent, { kind: 'permission_request' }>;

const fields = (value: unknown): Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
const wire = (value: unknown): string => JSON.stringify(value) + '\n';

/** App-server v2 stdio lifecycle, checked against the installed Codex CLI 0.162 schema. */
export function codexConnection(spec: SessionSpec, write: (data: string) => void): AgentConnection {
  let threadId: string | null = null;
  let model = spec.model || 'codex';
  let finalText = '';
  let usage: RunUsage | null = null;
  let window: number | null = null;
  let error: Fields = {};
  let compacted = false;
  const items = new Map<string, Fields>();
  const readOnly = spec.access === 'readOnly';
  const skip = !readOnly && spec.skipPermissions;
  const policy = {
    cwd: spec.cwd,
    approvalPolicy: readOnly || skip ? 'never' : 'on-request',
    approvalsReviewer: 'user',
    sandbox: readOnly ? 'read-only' : skip ? 'danger-full-access' : 'workspace-write',
    ...(spec.model ? { model: spec.model } : {}),
  };
  const send = (value: unknown) => write(wire(value));

  function response(msg: Fields): AgentEvent[] {
    if (msg.error) return [failed(fields(msg.error))];
    if (msg.id === 'hb:init') {
      send({ method: 'initialized' });
      send({
        id: 'hb:thread',
        method: spec.resume ? 'thread/resume' : 'thread/start',
        params: { ...policy, ...(spec.resume ? { threadId: spec.sessionId } : {}) },
      });
    } else if (msg.id === 'hb:thread') {
      const result = fields(msg.result);
      threadId = string(fields(result.thread).id);
      if (!threadId) return [failed({ message: 'Codex app-server returned no thread id' })];
      model = string(result.model) || spec.model || 'codex';
      // Keep user-configured writable roots, network and read restrictions from the
      // effective thread policy instead of replacing them with a hard-coded sandbox.
      const sandbox = fields(result.sandbox);
      const roots = Array.isArray(sandbox.writableRoots)
        ? sandbox.writableRoots.filter((root): root is string => typeof root === 'string')
        : [];
      send({
        id: 'hb:turn',
        method: 'turn/start',
        params: {
          threadId,
          cwd: spec.cwd,
          approvalPolicy: policy.approvalPolicy,
          approvalsReviewer: 'user',
          sandboxPolicy: readOnly
            ? { ...sandbox, type: 'readOnly' }
            : skip
              ? { type: 'dangerFullAccess' }
              : {
                  ...sandbox,
                  type: 'workspaceWrite',
                  writableRoots: [...new Set([spec.cwd, ...roots])],
                  networkAccess: sandbox.networkAccess === true,
                },
          ...(spec.model ? { model: spec.model } : {}),
          // Only `turn/start` takes an effort; `thread/start` and `thread/resume` have none.
          ...(spec.effort ? { effort: spec.effort } : {}),
          input: [{ type: 'text', text: spec.prompt }],
        },
      });
      return [{ kind: 'init', sessionId: threadId, model }];
    }
    return [];
  }

  function request(msg: Fields, params: Fields): AgentEvent[] {
    const method = string(msg.method);
    const event = approval(msg, params, items.get(string(params.itemId)), spec);
    if (event) {
      // Reviewers never offer a route out of their read-only policy, even on a resumed thread.
      if (readOnly || !spec.askPermission) {
        write(
          codexPermissionReply(event, {
            behavior: 'deny',
            message: 'This session cannot grant permissions.',
          }),
        );
        return [];
      }
      return [event];
    }
    if (method === 'item/tool/requestUserInput') {
      send({ id: msg.id, result: { answers: {} } });
    } else if (method === 'mcpServer/elicitation/request') {
      // Forms needing data and URL flows need a richer UI than an allow/deny prompt.
      send({ id: msg.id, result: { action: 'decline', content: null } });
    } else {
      send({
        id: msg.id,
        error: { code: -32601, message: `Unsupported Harnessboard request: ${method}` },
      });
    }
    return [
      {
        kind: 'tool_use',
        name: 'Codex',
        summary: `Unsupported interactive request declined: ${method}`,
      },
    ];
  }

  function notification(method: string, params: Fields): AgentEvent[] {
    if (method === 'error') {
      // Retryable stream errors do not end the turn; turn/completed is authoritative.
      error = fields(params.error);
    } else if (method === 'thread/tokenUsage/updated') {
      const tokens = fields(params.tokenUsage);
      usage = tokenUsage(fields(tokens.total), model);
      window = typeof tokens.modelContextWindow === 'number' ? tokens.modelContextWindow : null;
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = fields(params.item);
      items.set(string(item.id), item);
      if (item.type === 'contextCompaction' && method === 'item/completed') {
        compacted = true;
        return [];
      }
      if (item.type === 'agentMessage' && method === 'item/completed') {
        finalText = string(item.text);
        return [{ kind: 'text', text: finalText }];
      }
      return toolEvents(item, method === 'item/completed');
    } else if (method === 'turn/completed') {
      const turn = fields(params.turn);
      if (turn.status !== 'completed') return [failed(fields(turn.error ?? error), usage, window)];
      return [
        {
          kind: 'result',
          isError: false,
          text: finalText,
          apiErrorStatus: null,
          contextWindow: window,
          usage,
          ...(compacted ? { compacted: true } : {}),
        },
      ];
    }
    return [];
  }

  return {
    compact: () => {
      if (!threadId) throw new Error('cannot compact before a Codex thread is loaded');
      compacted = false;
      send({ id: 'hb:compact', method: 'thread/compact/start', params: { threadId } });
    },
    start: () => {
      if (spec.resume && !spec.sessionId)
        throw new Error('resuming a Codex session needs its thread id');
      send({
        id: 'hb:init',
        method: 'initialize',
        params: {
          clientInfo: { name: 'harnessboard', title: 'Harnessboard', version: '1' },
          capabilities: { experimentalApi: true },
        },
      });
    },
    parseLine: (line) => {
      let msg: Fields;
      try {
        msg = fields(JSON.parse(line));
      } catch {
        return [];
      }
      if (!msg.method) return response(msg);
      const params = fields(msg.params);
      if (params.threadId && params.threadId !== threadId) {
        if (msg.id !== undefined)
          send({ id: msg.id, error: { code: -32600, message: 'Inactive thread' } });
        return [];
      }
      return msg.id !== undefined ? request(msg, params) : notification(string(msg.method), params);
    },
  };
}

function approval(
  msg: Fields,
  params: Fields,
  item: Fields | undefined,
  spec: SessionSpec,
): PermissionEvent | null {
  const method = string(msg.method);
  const base = {
    kind: 'permission_request' as const,
    requestId: JSON.stringify(msg.id),
    suggestedRules: [] as string[],
  };
  const metadata = { rpcId: msg.id, rpcMethod: method, rpcParams: params };
  if (method === 'item/commandExecution/requestApproval') {
    const raw = string(params.command) || string(item?.command);
    const command = shellCommand(raw);
    const cwd = string(params.cwd) || string(item?.cwd) || spec.cwd;
    const network = fields(params.networkApprovalContext);
    const risk = params.additionalPermissions
      ? 'grants additional filesystem or network access'
      : raw
        ? riskOf('Bash', { command }, cwd)
        : 'grants network or command access without a command preview';
    return {
      ...base,
      toolName: 'Bash',
      summary: raw || `Network: ${string(network.host)} ${string(params.reason)}`,
      input: { ...metadata, command, cwd, approvalRisk: risk },
      suggestedRules: risk === null ? commandRules(command, spec.allowedTools) : [],
    };
  }
  if (method === 'item/fileChange/requestApproval') {
    const paths = Array.isArray(item?.changes)
      ? item.changes.map((change) => string(fields(change).path))
      : [];
    const grantRoot = string(params.grantRoot);
    const targets = [...paths, ...(grantRoot ? [grantRoot] : [])];
    const risk = grantRoot
      ? 'grants write access to a directory for the session'
      : targets.length
        ? targets.map((file_path) => riskOf('Edit', { file_path }, spec.cwd)).find(Boolean)
        : 'grants write access without a file preview';
    return {
      ...base,
      toolName: 'Edit',
      summary: targets.join(', ') || string(params.reason) || 'File changes',
      input: { ...metadata, file_path: targets[0], approvalRisk: risk ?? null },
    };
  }
  if (method === 'item/permissions/requestApproval') {
    return {
      ...base,
      toolName: 'CodexPermissions',
      summary: `${string(params.reason)} ${JSON.stringify(params.permissions)}`.trim(),
      input: { ...metadata, approvalRisk: 'grants additional filesystem or network access' },
    };
  }
  if (method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(params.questions) ? params.questions.map(fields) : [];
    if (!questions.length || !questions.every(isConfirmation)) return null;
    return {
      ...base,
      toolName: 'CodexApproval',
      summary: questions.map((q) => string(q.question)).join('\n'),
      input: { ...metadata, approvalRisk: 'approves an interactive tool action' },
    };
  }
  if (method === 'mcpServer/elicitation/request' && params.mode === 'form') {
    const schema = fields(params.requestedSchema);
    if (
      Object.keys(fields(schema.properties)).length ||
      (Array.isArray(schema.required) && schema.required.length)
    )
      return null;
    return {
      ...base,
      toolName: `mcp__${string(params.serverName)}__approval`,
      summary: string(params.message),
      input: { ...metadata, approvalRisk: 'approves an MCP server action' },
    };
  }
  return null;
}

/** Answer only this request; never persist an execpolicy amendment or grant session-wide access. */
export function codexPermissionReply(request: PermissionEvent, reply: PermissionReply): string {
  const allow = reply.behavior === 'allow';
  const method = request.input.rpcMethod;
  let result: unknown = { decision: allow ? 'accept' : 'decline' };
  if (method === 'item/permissions/requestApproval') {
    result = {
      permissions: allow ? fields(request.input.rpcParams).permissions : {},
      scope: 'turn',
    };
  } else if (method === 'mcpServer/elicitation/request') {
    result = { action: allow ? 'accept' : 'decline', content: allow ? {} : null };
  } else if (method === 'item/tool/requestUserInput') {
    const questions = fields(request.input.rpcParams).questions as Fields[];
    result = {
      answers: Object.fromEntries(
        questions.map((question) => {
          const options = question.options as Fields[];
          const option = options.find((o) =>
            (allow ? /^(accept|approve)$/i : /^(decline|deny|cancel)$/i).test(string(o.label)),
          )!;
          return [string(question.id), { answers: [string(option.label)] }];
        }),
      ),
    };
  }
  return wire({ id: request.input.rpcId, result });
}

/** Unwrap a shell's single quoted command for risk checks and conservative rule matching. */
function shellCommand(command: string): string {
  const match = command.match(/^(?:\S*\/)?(?:bash|sh|zsh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/);
  return match ? match[2]! : command;
}

/** Match plain commands against current rules; compound shell syntax cannot inherit a prefix allowance. */
export function matchingCodexRules(command: string, allowed: string[]): string[] {
  if (!command || /[;&|\n\r`$<>\\]/.test(command)) return [];
  return allowed.filter((rule) => {
    const match = rule.match(/^Bash\((.*)\)$/);
    if (!match) return false;
    const pattern = match[1]!;
    return pattern.endsWith(' *') ? command.startsWith(pattern.slice(0, -1)) : command === pattern;
  });
}

function commandRules(command: string, allowed: string[]): string[] {
  const matches = matchingCodexRules(command, allowed);
  if (matches.length) return matches;
  return command && !/[;&|\n\r`$<>\\]/.test(command) ? [`Bash(${command})`] : [];
}

function isConfirmation(question: Fields): boolean {
  if (
    question.isSecret ||
    question.isOther ||
    !string(question.id) ||
    !Array.isArray(question.options)
  )
    return false;
  const labels = question.options.map((option) => string(fields(option).label));
  return (
    labels.every((label) => /^(accept|approve|decline|deny|cancel)$/i.test(label)) &&
    labels.some((label) => /^(accept|approve)$/i.test(label)) &&
    labels.some((label) => /^(decline|deny|cancel)$/i.test(label))
  );
}

function toolEvents(item: Fields, completed: boolean): AgentEvent[] {
  if (item.type === 'commandExecution' && !completed) {
    return [{ kind: 'tool_use', name: 'Bash', summary: string(item.command) }];
  }
  if (item.type === 'fileChange' && completed) {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return [
      {
        kind: 'tool_use',
        name: 'Edit',
        summary: changes.map((c) => string(fields(c).path)).join(', '),
      },
    ];
  }
  if (item.type === 'mcpToolCall' && !completed) {
    return [
      { kind: 'tool_use', name: 'MCP', summary: `${string(item.server)} ${string(item.tool)}` },
    ];
  }
  if (item.type === 'webSearch' && !completed)
    return [{ kind: 'tool_use', name: 'WebSearch', summary: string(item.query) }];
  return [];
}

function tokenUsage(total: Fields, model: string): RunUsage {
  const count = (key: string) => (typeof total[key] === 'number' ? total[key] : 0);
  const tokens = {
    input: Math.max(
      0,
      count('inputTokens') - count('cachedInputTokens') - count('cacheWriteInputTokens'),
    ),
    output: count('outputTokens'),
    cacheRead: count('cachedInputTokens'),
    cacheWrite: count('cacheWriteInputTokens'),
  };
  const costUsd = estimateCodexCost(model, tokens);
  return {
    costUsd,
    models: { [model]: { ...tokens, costUsd } },
  };
}

function failed(
  error: Fields,
  usage: RunUsage | null = null,
  contextWindow: number | null = null,
): AgentEvent {
  const text = string(error.message) || 'Codex app-server turn failed';
  const info = fields(error.codexErrorInfo);
  const nested = Object.values(info)
    .map(fields)
    .find((entry) => typeof entry.httpStatusCode === 'number');
  const status =
    typeof info.httpStatusCode === 'number' ? info.httpStatusCode : nested?.httpStatusCode;
  return {
    kind: 'result',
    isError: true,
    text,
    apiErrorStatus:
      typeof status === 'number'
        ? status
        : /usage.?limit|quota/i.test(`${text} ${JSON.stringify(error.codexErrorInfo)}`)
          ? 429
          : null,
    contextWindow,
    usage,
  };
}
