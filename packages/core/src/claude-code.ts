// SPDX-License-Identifier: Apache-2.0
import type { AgentEvent, QuotaInfo } from '@harnessboard/shared';
import type { AgentAdapter, SessionSpec } from './agent.js';

/**
 * Drives `claude -p` in stream-json mode. Field names follow docs/stream-json-notes.md;
 * re-check them there when Claude Code changes its output.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly versionArgs = ['--version'];

  constructor(readonly command: string) {}

  buildArgs(spec: SessionSpec): string[] {
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
    if (spec.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else {
      args.push('--permission-mode', 'acceptEdits');
      if (spec.allowedTools.length > 0) args.push('--allowedTools', ...spec.allowedTools);
    }
    return args;
  }

  encodeMessage(text: string): string {
    return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
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
    resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
  };
}

function parseResult(msg: Record<string, unknown>): AgentEvent {
  const modelUsage = (msg.modelUsage ?? {}) as Record<string, { contextWindow?: number }>;
  const windows = Object.values(modelUsage)
    .map((m) => m.contextWindow)
    .filter((w): w is number => typeof w === 'number');
  return {
    kind: 'result',
    isError: msg.is_error === true,
    text: typeof msg.result === 'string' ? msg.result : '',
    apiErrorStatus: typeof msg.api_error_status === 'number' ? msg.api_error_status : null,
    contextWindow: windows.length > 0 ? Math.max(...windows) : null,
  };
}
