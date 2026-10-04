// SPDX-License-Identifier: Apache-2.0
import type { AgentEvent, ModelInfo, RunUsage } from '@harnessboard/shared';
import type { AgentAdapter, AgentCapabilities, LineParser, SessionSpec } from './agent.js';
import { parseCodexModels } from './models.js';
import { output } from './process.js';

/**
 * Drives `codex exec --json`. Event names follow the output of Codex CLI 0.160; re-check
 * them when Codex changes its output.
 *
 * Codex takes its prompt as an argument, assigns its own session ids, and cannot pause to
 * ask about a tool: the sandbox decides what it may do. It reports no context size per
 * model call, so no `context` events are emitted and Codex manages its own context.
 */
export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex';
  readonly versionArgs = ['--version'];
  readonly capabilities: AgentCapabilities = {
    midTurnInput: false,
    sessionIds: 'agent',
    permissionPrompts: false,
  };

  constructor(readonly command: string) {}

  /** The models Codex offers in its own picker, from its model catalog. */
  async listModels(): Promise<ModelInfo[]> {
    return parseCodexModels(JSON.parse(await output(this.command, ['debug', 'models'])));
  }

  /**
   * `-c sandbox_mode=...` is used instead of `--sandbox` because `exec resume` only
   * accepts the former. An unsandboxed edit session is what `skipPermissions` asks for;
   * with the sandbox on, Codex can edit the worktree but not commit, because a worktree's
   * git directory lies outside it.
   */
  buildArgs(spec: SessionSpec): string[] {
    const args = spec.resume ? ['exec', 'resume', '--json'] : ['exec', '--json'];
    // Nothing can answer an approval prompt in `exec`, so never raise one.
    args.push('-c', 'approval_policy="never"');
    if (spec.access === 'readOnly') args.push('-c', 'sandbox_mode="read-only"');
    else if (spec.skipPermissions) args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-c', 'sandbox_mode="workspace-write"');
    if (spec.model) args.push('-m', spec.model);
    if (spec.resume) {
      if (!spec.sessionId) throw new Error('resuming a Codex session needs its thread id');
      args.push(spec.sessionId);
    }
    args.push('--', spec.prompt);
    return args;
  }

  interactiveResumeArgs(agentSessionId: string): string[] {
    return ['resume', agentSessionId];
  }

  encodeMessage(): string {
    throw new Error('Codex takes its prompt as an argument, not on stdin');
  }

  encodePermissionReply(): string {
    throw new Error('Codex cannot ask for permission; its sandbox decides');
  }

  /** Stateless: a `result` from here has no final text. The runner uses {@link createParser}. */
  parseLine(line: string): AgentEvent[] {
    return this.createParser()(line);
  }

  /** The final reply is the turn's last message, so one parser must see the whole run. */
  createParser(): LineParser {
    let lastMessage = '';
    return (line) => {
      let msg: CodexLine;
      try {
        msg = JSON.parse(line) as CodexLine;
      } catch {
        return []; // the CLI prints non-JSON notes such as "Reading additional input"
      }
      switch (msg.type) {
        case 'thread.started':
          return msg.thread_id ? [{ kind: 'init', sessionId: msg.thread_id, model: 'codex' }] : [];
        case 'item.started':
        case 'item.completed': {
          const events = parseItem(msg.type === 'item.completed', msg.item);
          for (const event of events) if (event.kind === 'text') lastMessage = event.text;
          return events;
        }
        case 'turn.completed':
          return [
            {
              kind: 'result',
              isError: false,
              text: lastMessage,
              apiErrorStatus: null,
              contextWindow: null,
              usage: parseUsage(msg.usage),
            },
          ];
        case 'turn.failed':
          return [failure(msg.error?.message)];
        default:
          return []; // `error` is always followed by `turn.failed`, which carries the same text
      }
    };
  }
}

interface CodexLine {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: CodexUsage;
  error?: { message?: string };
}

interface CodexItem {
  type?: string;
  text?: string;
  command?: string;
  query?: string;
  server?: string;
  tool?: string;
  changes?: { path?: string; kind?: string }[];
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

function parseItem(completed: boolean, item: CodexItem | undefined): AgentEvent[] {
  if (!item) return [];
  switch (item.type) {
    case 'agent_message':
      return completed && item.text ? [{ kind: 'text', text: item.text }] : [];
    // A command shows up twice (started, completed); report it once, when it starts.
    case 'command_execution':
      return completed ? [] : [{ kind: 'tool_use', name: 'Bash', summary: clip(item.command) }];
    case 'file_change': {
      if (!completed) return [];
      const paths = (item.changes ?? []).map((c) => c.path ?? '?').join(', ');
      return [{ kind: 'tool_use', name: 'Edit', summary: clip(paths) }];
    }
    case 'mcp_tool_call':
      return completed ? [] : [{ kind: 'tool_use', name: 'MCP', summary: clip(toolName(item)) }];
    case 'web_search':
      return completed ? [] : [{ kind: 'tool_use', name: 'WebSearch', summary: clip(item.query) }];
    default:
      return []; // reasoning, plans and warnings are not part of the log
  }
}

function toolName(item: CodexItem): string {
  return [item.server, item.tool].filter(Boolean).join(':');
}

function clip(text: string | undefined): string {
  const value = text ?? '';
  return value.length > 200 ? `${value.slice(0, 197)}...` : value;
}

/** Codex reports one turn's tokens and no price; `cacheWrite` is counted with input. */
function parseUsage(usage: CodexUsage | undefined): RunUsage | null {
  if (!usage) return null;
  const cacheRead = usage.cached_input_tokens ?? 0;
  const cacheWrite = usage.cache_write_input_tokens ?? 0;
  return {
    costUsd: null,
    models: {
      codex: {
        input: Math.max((usage.input_tokens ?? 0) - cacheRead - cacheWrite, 0),
        output: usage.output_tokens ?? 0,
        cacheRead,
        cacheWrite,
        costUsd: null,
      },
    },
  };
}

/**
 * `turn.failed` carries the API error as a JSON string, e.g.
 * `{"type":"error","status":400,"error":{"message":"..."}}`; plain text is kept as it is.
 * A usage-limit message without a status is treated as 429 so the task waits and retries.
 */
function failure(raw: string | undefined): AgentEvent {
  let text = raw ?? 'Codex failed without a message';
  let status: number | null = null;
  try {
    const body = JSON.parse(text) as { status?: number; error?: { message?: string } };
    if (typeof body.status === 'number') status = body.status;
    if (body.error?.message) text = body.error.message;
  } catch {
    // not JSON: keep the text
  }
  if (status === null && /usage limit|rate limit/i.test(text)) status = 429;
  return {
    kind: 'result',
    isError: true,
    text,
    apiErrorStatus: status,
    contextWindow: null,
    usage: null,
  };
}
