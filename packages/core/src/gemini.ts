// SPDX-License-Identifier: Apache-2.0
import type { AgentEvent, RunUsage } from '@harnessboard/shared';
import type { AgentAdapter, AgentCapabilities, LineParser, SessionSpec } from './agent.js';

/**
 * Drives `gemini --prompt ... --output-format stream-json`. Event names and fields follow
 * the stream-json types in the Gemini CLI source (`packages/core/src/output/types.ts`);
 * they have not been checked against a real run yet, so everything is read defensively.
 *
 * Gemini takes its prompt as an argument, assigns its own session ids, and cannot pause to
 * ask about a tool: its approval mode decides. It reports tokens only once, at the end of
 * the run, so no `context` events are emitted and Gemini manages its own context.
 */
export class GeminiAdapter implements AgentAdapter {
  readonly provider = 'gemini';
  readonly versionArgs = ['--version'];
  readonly capabilities: AgentCapabilities = {
    midTurnInput: false,
    sessionIds: 'agent',
    permissionPrompts: false,
  };

  constructor(readonly command: string) {}

  /**
   * Access maps to `--approval-mode`: `plan` is Gemini's read-only mode, `yolo` approves
   * every tool, and `auto_edit` approves file edits only. Without a terminal nothing can
   * answer an approval, so under `auto_edit` shell commands are refused, which also means
   * such a session can not commit. `allowedTools` are Claude-style rules that Gemini does
   * not understand, so they are not passed on.
   */
  buildArgs(spec: SessionSpec): string[] {
    const args = ['--output-format', 'stream-json'];
    if (spec.access === 'readOnly') args.push('--approval-mode', 'plan');
    else if (spec.skipPermissions) args.push('--approval-mode', 'yolo');
    else args.push('--approval-mode', 'auto_edit');
    if (spec.model) args.push('--model', spec.model);
    if (spec.resume) {
      if (!spec.sessionId) throw new Error('resuming a Gemini session needs its session id');
      args.push('--resume', spec.sessionId);
    }
    // One argument with `=`, so a prompt starting with `-` is not read as an option.
    args.push(`--prompt=${spec.prompt}`);
    return args;
  }

  interactiveResumeArgs(agentSessionId: string): string[] {
    return ['--resume', agentSessionId];
  }

  encodeMessage(): string {
    throw new Error('Gemini takes its prompt as an argument, not on stdin');
  }

  encodePermissionReply(): string {
    throw new Error('Gemini cannot ask for permission; its approval mode decides');
  }

  /** Stateless: a `result` from here has no final text. The runner uses {@link createParser}. */
  parseLine(line: string): AgentEvent[] {
    return this.createParser()(line);
  }

  /**
   * The reply arrives as `message` chunks, so one parser must see the whole run. A message
   * ends at the next tool call or at the result; the result's text is the last message.
   */
  createParser(): LineParser {
    let current = '';
    let lastMessage = '';
    let lastError: string | null = null;
    const flush = (): AgentEvent[] => {
      const text = current.trim();
      current = '';
      if (!text) return [];
      lastMessage = text;
      return [{ kind: 'text', text }];
    };
    return (line) => {
      let msg: GeminiLine;
      try {
        msg = JSON.parse(line) as GeminiLine;
      } catch {
        return []; // the CLI may print notes that are not JSON
      }
      switch (msg.type) {
        case 'init':
          return msg.session_id
            ? [{ kind: 'init', sessionId: msg.session_id, model: msg.model ?? 'gemini' }]
            : [];
        case 'message':
          if (msg.role === 'assistant' && msg.content) current += msg.content;
          return []; // the user's own prompt is echoed back as a `user` message
        case 'tool_use':
          return [
            ...flush(),
            { kind: 'tool_use', name: msg.tool_name ?? '?', summary: summarize(msg.parameters) },
          ];
        case 'error':
          if (msg.severity === 'error' && msg.message) lastError = msg.message;
          return [];
        case 'result': {
          const events = flush();
          const usage = parseUsage(msg.stats);
          if (msg.status === 'error') {
            events.push(failure(msg.error?.message ?? lastError, usage));
          } else {
            events.push({
              kind: 'result',
              isError: false,
              text: lastMessage,
              apiErrorStatus: null,
              contextWindow: null,
              usage,
            });
          }
          return events;
        }
        default:
          return []; // tool results are not part of the log
      }
    };
  }
}

interface GeminiLine {
  type?: string;
  session_id?: string;
  model?: string;
  role?: string;
  content?: string;
  tool_name?: string;
  parameters?: Record<string, unknown>;
  severity?: string;
  message?: string;
  status?: string;
  error?: { type?: string; message?: string };
  stats?: GeminiStats;
}

interface GeminiTokens {
  input_tokens?: number;
  output_tokens?: number;
  cached?: number;
  /** Input tokens that were not read from the cache. */
  input?: number;
}

interface GeminiStats extends GeminiTokens {
  models?: Record<string, GeminiTokens>;
}

function summarize(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const preferred =
    input.command ?? input.file_path ?? input.absolute_path ?? input.path ?? input.pattern;
  const text = typeof preferred === 'string' ? preferred : JSON.stringify(input);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/** Tokens per model as Gemini reports them, without a price; Gemini reports no cache writes. */
function parseUsage(stats: GeminiStats | undefined): RunUsage | null {
  if (!stats) return null;
  const perModel = stats.models && Object.keys(stats.models).length > 0 ? stats.models : null;
  const models: RunUsage['models'] = {};
  for (const [model, tokens] of Object.entries(perModel ?? { gemini: stats })) {
    const cacheRead = tokens.cached ?? 0;
    models[model] = {
      input: tokens.input ?? Math.max((tokens.input_tokens ?? 0) - cacheRead, 0),
      output: tokens.output_tokens ?? 0,
      cacheRead,
      cacheWrite: 0,
      costUsd: null,
    };
  }
  return { costUsd: null, models };
}

/**
 * A failed run. Gemini has no usage-limit event, so a message about quota or rate limits
 * (the API's `RESOURCE_EXHAUSTED`, HTTP 429) counts as 429 and the task waits and retries.
 */
function failure(message: string | null | undefined, usage: RunUsage | null): AgentEvent {
  const text = message || 'Gemini failed without a message';
  const limited = /quota|rate limit|resource.?exhausted|\b429\b/i.test(text);
  return {
    kind: 'result',
    isError: true,
    text,
    apiErrorStatus: limited ? 429 : null,
    contextWindow: null,
    usage,
  };
}
