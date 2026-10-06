// SPDX-License-Identifier: Apache-2.0
import type { AgentEvent, ModelInfo, QuotaInfo, RunUsage } from '@harnessboard/shared';
import type { AgentAdapter, AgentCapabilities, PermissionReply, SessionSpec } from './agent.js';
import { readClaudeModels } from './models.js';

type PermissionRequestEvent = Extract<AgentEvent, { kind: 'permission_request' }>;

/** What a reviewer may use: read files and inspect history, nothing that changes them. */
export const READ_ONLY_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(git status)',
];

/**
 * Drives `claude -p` in stream-json mode. Field names follow docs/stream-json-notes.md;
 * re-check them there when Claude Code changes its output.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly provider = 'claude-code';
  readonly versionArgs = ['--version'];
  readonly capabilities: AgentCapabilities = {
    midTurnInput: true,
    sessionIds: 'harness',
    permissionPrompts: true,
    readOnlyGit: true,
  };

  constructor(readonly command: string) {}

  /** The models in Claude Code's own model menu for this account, or its aliases. */
  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(readClaudeModels());
  }

  /** Throws when `sessionId` is missing: this CLI always gets its id from the harness. */
  buildArgs(spec: SessionSpec): string[] {
    if (!spec.sessionId) throw new Error('Claude Code sessions need a harness-chosen id');
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      spec.resume ? '--resume' : '--session-id',
      spec.sessionId,
    ];
    if (spec.model) args.push('--model', spec.model);
    if (spec.access === 'readOnly') {
      // Default permission mode: in print mode every tool not listed here is refused.
      args.push('--allowedTools', ...READ_ONLY_TOOLS, ...spec.allowedTools);
    } else if (spec.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', 'acceptEdits');
      if (spec.allowedTools.length > 0) args.push('--allowedTools', ...spec.allowedTools);
      // The CLI then sends a `can_use_tool` request on stdout and waits for our answer.
      if (spec.askPermission) args.push('--permission-prompt-tool', 'stdio');
    }
    return args;
  }

  interactiveResumeArgs(agentSessionId: string): string[] {
    return ['--resume', agentSessionId];
  }

  encodeMessage(text: string): string {
    return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
  }

  encodePermissionReply(request: PermissionRequestEvent, reply: PermissionReply): string {
    const response =
      reply.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: request.input }
        : { behavior: 'deny', message: reply.message || 'The user denied this tool use.' };
    return (
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: request.requestId, response },
      }) + '\n'
    );
  }

  parseLine(line: string): AgentEvent[] {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return []; // the CLI occasionally prints non-JSON diagnostics; they are not events
    }
    switch (msg.type) {
      case 'system':
        return parseSystem(msg);
      case 'assistant':
        return parseAssistant(msg);
      case 'rate_limit_event':
        return [{ kind: 'quota', quota: parseQuota(msg.rate_limit_info) }];
      case 'result':
        return [parseResult(msg)];
      case 'control_request':
        return parseControlRequest(msg);
      default:
        return [];
    }
  }
}

function parseSystem(msg: Record<string, unknown>): AgentEvent[] {
  if (msg.subtype === 'init') {
    return [{ kind: 'init', sessionId: String(msg.session_id), model: String(msg.model) }];
  }
  if (msg.subtype === 'compact_boundary') {
    const meta = (msg.compact_metadata ?? {}) as Record<string, unknown>;
    return [
      {
        kind: 'compact',
        preTokens: Number(meta.pre_tokens ?? 0),
        postTokens: Number(meta.post_tokens ?? 0),
      },
    ];
  }
  return [];
}

interface RuleSuggestion {
  type?: string;
  behavior?: string;
  rules?: { toolName?: string; ruleContent?: string }[];
}

function parseControlRequest(msg: Record<string, unknown>): AgentEvent[] {
  const request = (msg.request ?? {}) as {
    subtype?: string;
    tool_name?: string;
    input?: Record<string, unknown>;
    permission_suggestions?: RuleSuggestion[];
  };
  if (request.subtype !== 'can_use_tool' || typeof msg.request_id !== 'string') return [];
  const suggestedRules: string[] = [];
  for (const suggestion of request.permission_suggestions ?? []) {
    if (suggestion.type !== 'addRules' || suggestion.behavior !== 'allow') continue;
    for (const rule of suggestion.rules ?? []) {
      if (!rule.toolName) continue;
      const text = rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
      if (!suggestedRules.includes(text)) suggestedRules.push(text);
    }
  }
  const input = request.input ?? {};
  return [
    {
      kind: 'permission_request',
      requestId: msg.request_id,
      toolName: request.tool_name ?? '?',
      summary: summarizeToolInput(input),
      input,
      suggestedRules,
    },
  ];
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function parseAssistant(msg: Record<string, unknown>): AgentEvent[] {
  const message = (msg.message ?? {}) as { content?: ContentBlock[]; usage?: Usage };
  // Sub-agent turns report their own, separate context; only the main thread counts.
  const isMainThread = msg.parent_tool_use_id == null;
  const events: AgentEvent[] = [];
  for (const block of message.content ?? []) {
    if (block.type === 'text' && block.text) events.push({ kind: 'text', text: block.text });
    if (block.type === 'tool_use') {
      events.push({
        kind: 'tool_use',
        name: block.name ?? '?',
        summary: summarizeToolInput(block.input),
      });
    }
  }
  if (isMainThread && message.usage) {
    events.push({ kind: 'context', tokens: contextTokens(message.usage) });
  }
  return events;
}

interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Tokens the model saw on this call, i.e. the current context size. */
export function contextTokens(usage: Usage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const preferred = input.command ?? input.file_path ?? input.pattern ?? input.description;
  const text = typeof preferred === 'string' ? preferred : JSON.stringify(input);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function parseQuota(raw: unknown): QuotaInfo {
  const info = (raw ?? {}) as {
    status?: string;
    resetsAt?: number;
    unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
  };
  const windows = info.unifiedWindows ?? {};
  return {
    status: info.status ?? 'unknown',
    fiveHourUtilization: windows.five_hour?.utilization ?? null,
    sevenDayUtilization: windows.seven_day?.utilization ?? null,
    fiveHourResetsAt: toMs(windows.five_hour?.resetsAt),
    sevenDayResetsAt: toMs(windows.seven_day?.resetsAt),
    resetsAt: toMs(info.resetsAt),
  };
}

/** The CLI reports reset times in Unix seconds. */
function toMs(seconds: number | undefined): number | null {
  return seconds ? seconds * 1000 : null;
}

function parseResult(msg: Record<string, unknown>): AgentEvent {
  const modelUsage = (msg.modelUsage ?? {}) as Record<string, ModelUsage>;
  const windows = Object.values(modelUsage)
    .map((m) => m.contextWindow)
    .filter((w): w is number => typeof w === 'number');
  return {
    kind: 'result',
    isError: msg.is_error === true,
    text: typeof msg.result === 'string' ? msg.result : '',
    apiErrorStatus: typeof msg.api_error_status === 'number' ? msg.api_error_status : null,
    contextWindow: windows.length > 0 ? Math.max(...windows) : null,
    usage: parseUsage(modelUsage, msg.total_cost_usd),
  };
}

interface ModelUsage {
  contextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

/**
 * `modelUsage` and `total_cost_usd` are the conversation's totals so far: they grow with
 * each turn of one process and are restored when the conversation is resumed.
 */
function parseUsage(modelUsage: Record<string, ModelUsage>, totalCost: unknown): RunUsage | null {
  const models: RunUsage['models'] = {};
  for (const [model, m] of Object.entries(modelUsage)) {
    if (m.inputTokens === undefined && m.outputTokens === undefined) continue;
    models[model] = {
      input: m.inputTokens ?? 0,
      output: m.outputTokens ?? 0,
      cacheRead: m.cacheReadInputTokens ?? 0,
      cacheWrite: m.cacheCreationInputTokens ?? 0,
      costUsd: typeof m.costUSD === 'number' ? m.costUSD : null,
    };
  }
  const costUsd = typeof totalCost === 'number' ? totalCost : null;
  if (costUsd === null && Object.keys(models).length === 0) return null;
  return { costUsd, models };
}
