// SPDX-License-Identifier: Apache-2.0
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, ModelInfo, QuotaInfo, RunUsage } from '@harnessboard/shared';
import type {
  AgentAdapter,
  AgentCapabilities,
  LineParser,
  PermissionReply,
  SessionSpec,
} from './agent.js';
import { codexConnection, codexPermissionReply } from './codex-app-server.js';
import { readCodexQuota } from './codex-quota.js';
import { parseCodexModels } from './models.js';
import { output } from './process.js';

/**
 * Drives Codex app-server over stdio RPC, including tool approvals. Legacy exec parsing
 * is retained for stored output and fixtures; live sessions use a per-process connection.
 */
export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex';
  readonly versionArgs = ['--version'];
  readonly capabilities: AgentCapabilities = {
    compaction: true,
    midTurnInput: false,
    sessionIds: 'agent',
    permissionPrompts: true,
    readOnlyGit: true,
    effort: true,
  };

  constructor(readonly command: string) {}

  /** The account's usage as Codex last recorded it in a session log. */
  readQuota(): Promise<QuotaInfo | null> {
    return Promise.resolve(readCodexQuota());
  }

  /** The models Codex offers in its own picker, from its model catalog. */
  async listModels(): Promise<ModelInfo[]> {
    return parseCodexModels(JSON.parse(await output(this.command, ['debug', 'models'])));
  }

  /** Enforce the same policy at process startup and when starting or resuming a thread. */
  buildArgs(spec: SessionSpec): string[] {
    if (spec.resume && !spec.sessionId)
      throw new Error('resuming a Codex session needs its thread id');
    const readOnly = spec.access === 'readOnly';
    const skip = !readOnly && spec.skipPermissions;
    return [
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      `approval_policy="${readOnly || skip ? 'never' : 'on-request'}"`,
      '-c',
      `sandbox_mode="${readOnly ? 'read-only' : skip ? 'danger-full-access' : 'workspace-write'}"`,
      '-c',
      'approvals_reviewer="user"',
    ];
  }

  createConnection(spec: SessionSpec, write: (data: string) => void) {
    return codexConnection(spec, write);
  }

  interactiveResumeArgs(agentSessionId: string): string[] {
    return ['resume', agentSessionId];
  }

  /** The login, settings and session logs; `CODEX_HOME` is not followed. */
  configPaths(): string[] {
    return [path.join(os.homedir(), '.codex')];
  }

  encodeMessage(): string {
    throw new Error('Codex takes its prompt as an argument, not on stdin');
  }

  encodePermissionReply(
    request: Extract<AgentEvent, { kind: 'permission_request' }>,
    reply: PermissionReply,
  ): string {
    return codexPermissionReply(request, reply);
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
