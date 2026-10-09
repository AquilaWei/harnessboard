// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, RunUsage } from '@harnessboard/shared';
import type {
  AgentAdapter,
  AgentCapabilities,
  LineParser,
  SessionAccess,
  SessionSpec,
} from './agent.js';

/**
 * Drives `gemini --output-format stream-json` with the prompt on stdin. Event names and fields follow
 * the stream-json types in the Gemini CLI source (`packages/core/src/output/types.ts`);
 * they have not been checked against a real run yet, so everything is read defensively.
 *
 * Gemini reads its prompt from stdin, assigns its own session ids, and cannot pause to
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
    readOnlyGit: false,
    // The `gemini` CLI has no effort option; a given effort is ignored.
    effort: false,
  };

  /**
   * `systemPoliciesDir` is where Gemini looks for the machine's system policies; tests point
   * it at a directory of their own.
   */
  constructor(
    readonly command: string,
    private readonly systemPoliciesDir = SYSTEM_POLICIES_DIR,
  ) {}

  /**
   * Access maps to `--approval-mode`: `plan` is Gemini's read-only mode, `yolo` approves
   * every tool, and `auto_edit` approves file edits only. Without a terminal nothing can
   * answer an approval, so under `auto_edit` shell commands are refused, which also means
   * such a session can not commit. `plan` refuses git as well, so the harness gives a
   * reviewer the git output (`readOnlyGit`) in files under `readableDirs`, which join the
   * workspace with `--include-directories`. `allowedTools` are Claude-style rules that
   * Gemini does not understand, so they are not passed on.
   *
   * `plan` alone is not read-only: headless, Gemini approves `exit_plan_mode` by itself and
   * then switches to `yolo`, and the user's own allowances (settings, `~/.gemini/policies`)
   * outrank plan mode's refusals. A read-only session, new or resumed, therefore also gets
   * {@link READ_ONLY_POLICY} with `--admin-policy`, which outranks both. Gemini ignores that
   * flag when the machine has system policies, so then the session is refused instead; in
   * a Docker sandbox the image's are hidden ({@link containerEmptyDirs}).
   * Throws if there are system policies or the policy file can not be written.
   */
  buildArgs(spec: SessionSpec): string[] {
    const args = ['--output-format', 'stream-json'];
    if (spec.access === 'readOnly') {
      refuseIfSystemPolicies(this.systemPoliciesDir);
      args.push('--approval-mode', 'plan', '--admin-policy', readOnlyPolicyFile());
    } else if (spec.skipPermissions) args.push('--approval-mode', 'yolo');
    else args.push('--approval-mode', 'auto_edit');
    if (spec.model) args.push('--model', spec.model);
    for (const dir of spec.readableDirs ?? []) args.push('--include-directories', dir);
    if (spec.resume) {
      if (!spec.sessionId) throw new Error('resuming a Gemini session needs its session id');
      args.push('--resume', spec.sessionId);
    }
    return args; // the prompt goes to stdin (encodePrompt)
  }

  /**
   * Gemini runs headless when stdin is not a terminal and takes all of stdin as the prompt.
   * Not an argument: through `gemini.cmd` a prompt longer than cmd.exe's 8,191-character
   * command line would fail before Gemini starts, and a review prompt is often that long.
   */
  encodePrompt(text: string): string {
    return text;
  }

  interactiveResumeArgs(agentSessionId: string): string[] {
    return ['--resume', agentSessionId];
  }

  /**
   * The login and settings (`GEMINI_CLI_HOME` is not followed) and, for a read-only
   * session, the folder of the policy file `buildArgs` passes.
   */
  configPaths(access: SessionAccess): string[] {
    const home = path.join(os.homedir(), '.gemini');
    return access === 'readOnly' ? [home, path.dirname(readOnlyPolicyFile())] : [home];
  }

  /**
   * In a Docker sandbox the image's system policy folder would make Gemini ignore
   * `--admin-policy` just as this machine's would, so a read-only session gets it emptied.
   * Its path is the Linux one whatever this machine runs, because the container is Linux.
   * {@link buildArgs} still refuses when this machine has system policies, so the sandbox
   * is no way around them.
   */
  containerEmptyDirs(access: SessionAccess): string[] {
    return access === 'readOnly' ? [LINUX_SYSTEM_POLICIES_DIR] : [];
  }

  encodeMessage(): string {
    throw new Error('Gemini reads only its first prompt from stdin, not further messages');
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

/**
 * Lets a read-only session only read and search. Admin rules rank 5 + priority / 1000, above
 * every user allowance (at most 4.999) and Gemini's own rules (1.x), so the catch-all deny
 * (5.900) refuses edits, shell, MCP tools, subagents and `exit_plan_mode` in every mode,
 * and only the tools listed under it (5.950) run.
 */
const READ_ONLY_POLICY = `# Written by Harnessboard for read-only (reviewer) sessions.
[[rule]]
toolName = "*"
decision = "deny"
priority = 900
denyMessage = "This session is read-only: it may only read and search files."

[[rule]]
toolName = ["read_file", "read_many_files", "glob", "grep_search", "list_directory", "google_web_search"]
decision = "allow"
priority = 950
`;

const LINUX_SYSTEM_POLICIES_DIR = '/etc/gemini-cli/policies';

/** Where Gemini looks for system policies (`Storage.getSystemPoliciesDir` in its source). */
const SYSTEM_POLICIES_DIR =
  process.platform === 'darwin'
    ? '/Library/Application Support/GeminiCli/policies'
    : process.platform === 'win32'
      ? 'C:\\ProgramData\\gemini-cli\\policies'
      : LINUX_SYSTEM_POLICIES_DIR;

/**
 * Gemini ignores `--admin-policy` once its system policy directory holds a `.toml` file, so
 * a read-only session could then not be held to {@link READ_ONLY_POLICY}. A directory that
 * can not be read is fine: Gemini then can not read it either and keeps the admin policy.
 */
function refuseIfSystemPolicies(dir: string): void {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  if (files.some((f) => f.endsWith('.toml'))) {
    throw new Error(
      `Gemini ignores --admin-policy because ${dir} has system policies, so a read-only ` +
        'session could edit files and run commands; use another reviewer on this machine',
    );
  }
}

let policyDir: string | null = null;

/**
 * The path of {@link READ_ONLY_POLICY}, written on first use into a private temporary
 * directory (so no other user can change it) and again if something cleaned it away.
 * Synchronous because `buildArgs` is; the file is tiny.
 */
function readOnlyPolicyFile(): string {
  policyDir ??= mkdtempSync(path.join(os.tmpdir(), 'harnessboard-gemini-'));
  const file = path.join(policyDir, 'read-only.toml');
  if (!existsSync(file)) {
    mkdirSync(policyDir, { recursive: true, mode: 0o700 });
    writeFileSync(file, READ_ONLY_POLICY);
  }
  return file;
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
