// SPDX-License-Identifier: Apache-2.0
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import spawn from 'cross-spawn';
import treeKill from 'tree-kill';

/** What local AI is used for; each use case picks its own model in the config. */
export type LocalAiUseCase = 'pricing';

export interface LocalAiConfig {
  /** Off by default: local AI is an optional helper. */
  enabled: boolean;
  /** Path of the `localai` binary; `null` looks `localai` up on PATH. */
  command: string | null;
  models: Record<LocalAiUseCase, string>;
}

/**
 * Outcome of a request. It is a value, never a throw, so callers can fall back without
 * a try/catch and a missing or broken local AI cannot fail a Harnessboard flow.
 */
export type LocalAiResult =
  | { status: 'ok'; answer: string; reasoning: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: string };

export interface LocalAiRequest {
  /** At most 1 MiB; `localai` refuses more on stdin. */
  prompt: string;
  /** Kills the run when it takes longer. */
  timeoutMs: number;
  /** Aborting kills the run. */
  signal?: AbortSignal;
}

const PROTOCOL_VERSION = 1;
const REQUEST_ID = /^[0-9a-f]{32}$/;

/** Wire events after the envelope was checked; `data` is validated per type. */
interface Envelope {
  type: string;
  data: Record<string, unknown>;
}

/**
 * Accumulates one run's NDJSON events and enforces the v1 contract: one constant
 * request_id, start first, then deltas, then usage, then exactly one done or error.
 */
class RunParser {
  answer = '';
  reasoning = '';
  /** Set when the stream breaks the contract or reports an error. */
  failure: string | null = null;
  /** True after a `done` event; only then may the run succeed. */
  done = false;
  private requestId: string | null = null;
  private stage: 'start' | 'delta' | 'usage' | 'end' = 'start';

  line(text: string): void {
    if (this.failure !== null || text.trim() === '') return;
    const envelope = this.envelope(text);
    if (envelope) this.event(envelope);
  }

  private fail(reason: string): void {
    this.failure ??= reason;
  }

  private envelope(text: string): Envelope | null {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.fail('localai printed a line that is not JSON');
      return null;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail('localai printed a line that is not an event object');
      return null;
    }
    const e = value as Record<string, unknown>;
    if (e.version !== PROTOCOL_VERSION) {
      this.fail(`localai protocol version ${String(e.version)} is not supported (need 1)`);
      return null;
    }
    if (typeof e.request_id !== 'string' || !REQUEST_ID.test(e.request_id)) {
      this.fail('localai event has no valid request_id');
      return null;
    }
    if (this.requestId !== null && e.request_id !== this.requestId) {
      this.fail('localai request_id changed during the run');
      return null;
    }
    this.requestId = e.request_id;
    const data = e.data;
    if (typeof e.type !== 'string' || typeof data !== 'object' || data === null) {
      this.fail('localai event has no type or data');
      return null;
    }
    return { type: e.type, data: data as Record<string, unknown> };
  }

  private event({ type, data }: Envelope): void {
    if (this.stage === 'end') return this.fail(`localai sent ${type} after the final event`);
    // An error may come at any point, even before start (early initialisation failures).
    if (type === 'error') return this.terminal(type, data);
    if (type === 'start') {
      if (this.stage !== 'start') return this.fail('localai sent start twice');
      this.stage = 'delta';
    } else if (this.stage === 'start') {
      this.fail(`localai sent ${type} before start`);
    } else if (type === 'delta') {
      this.delta(data);
    } else if (type === 'usage') {
      // Usage may be "unavailable" with null counts; it is not needed, so it is never read.
      if (this.stage !== 'delta') return this.fail('localai sent usage out of order');
      this.stage = 'usage';
    } else if (type === 'done') {
      this.terminal(type, data);
    } else {
      this.fail(`localai sent unknown event type ${type}`);
    }
  }

  private delta(data: Record<string, unknown>): void {
    if (this.stage !== 'delta') return this.fail('localai sent delta out of order');
    if (
      (data.channel !== 'answer' && data.channel !== 'reasoning') ||
      typeof data.text !== 'string'
    ) {
      return this.fail('localai sent a malformed delta');
    }
    if (data.channel === 'answer') this.answer += data.text;
    else this.reasoning += data.text;
  }

  private terminal(type: 'done' | 'error', data: Record<string, unknown>): void {
    if (type === 'done' && this.stage !== 'usage') {
      return this.fail('localai finished without a usage event');
    }
    this.stage = 'end';
    if (type === 'done') {
      this.done = true;
    } else {
      this.fail(typeof data.message === 'string' ? data.message : 'localai reported an error');
    }
  }
}

/**
 * Runs `localai run --json` requests one at a time. Never throws from `run`: anything
 * that goes wrong becomes an `unavailable` or `failed` result.
 */
export class LocalAi {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: LocalAiConfig) {}

  /** The configured binary, or `localai` found on PATH. */
  get command(): string {
    return this.config.command ?? 'localai';
  }

  /**
   * Why local AI cannot run, or `null` when it can. Looks the binary up without starting it
   * (starting could load a model). Reasons: disabled in config, or binary not found.
   */
  unavailableReason(env: NodeJS.ProcessEnv = process.env): string | null {
    if (!this.config.enabled) return 'local AI is disabled (set localAi.enabled in the config)';
    return findExecutable(this.command, env)
      ? null
      : `the "${this.command}" binary was not found (install LocalAICLI or set localAi.command)`;
  }

  /**
   * Asks the model configured for `useCase`. Requests are queued so only one `localai`
   * process runs at a time. A partial answer is never returned as success: without a
   * `done` event and exit code 0 the result is `failed`.
   */
  run(useCase: LocalAiUseCase, request: LocalAiRequest): Promise<LocalAiResult> {
    const result = this.queue.then(() => this.runNow(useCase, request));
    this.queue = result;
    return result;
  }

  private async runNow(useCase: LocalAiUseCase, request: LocalAiRequest): Promise<LocalAiResult> {
    const unavailable = this.unavailableReason();
    if (unavailable) return { status: 'unavailable', reason: unavailable };
    if (request.signal?.aborted) return { status: 'failed', reason: 'cancelled' };
    const model = this.config.models[useCase];
    return execute(this.command, ['run', '--json', '--model', model], request);
  }
}

/** Spawns one process, feeds the prompt and resolves after the process has exited. */
function execute(command: string, args: string[], request: LocalAiRequest): Promise<LocalAiResult> {
  return new Promise((resolve) => {
    const parser = new RunParser();
    const stderr: string[] = [];
    let interruption: string | null = null;
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = (reason: string) => {
      interruption ??= reason;
      // The tree: localai owns a model server, which must not outlive the request.
      if (child.pid !== undefined && child.exitCode === null) treeKill(child.pid);
    };
    const timer = setTimeout(
      () => stop(`timed out after ${request.timeoutMs} ms`),
      request.timeoutMs,
    );
    const onAbort = () => stop('cancelled');
    request.signal?.addEventListener('abort', onAbort, { once: true });

    // Read line by line and keep draining both pipes until exit, even after a failure.
    createInterface({ input: child.stdout! }).on('line', (line) => parser.line(line));
    createInterface({ input: child.stderr! }).on('line', (line) => {
      stderr.push(line);
      if (stderr.length > 20) stderr.shift();
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(request.prompt);

    const finish = (result: LocalAiResult) => {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    child.once('error', (err) =>
      finish({ status: 'unavailable', reason: `cannot start ${command}: ${err.message}` }),
    );
    child.once('close', (code) => {
      if (interruption !== null) return finish({ status: 'failed', reason: interruption });
      if (parser.failure !== null) return finish({ status: 'failed', reason: parser.failure });
      if (!parser.done) {
        const tail = stderr.length > 0 ? `: ${stderr.join(' | ')}` : '';
        return finish({
          status: 'failed',
          reason: `localai ended without a final event (exit ${String(code)})${tail}`,
        });
      }
      if (code !== 0) {
        return finish({ status: 'failed', reason: `localai exited with code ${String(code)}` });
      }
      finish({ status: 'ok', answer: parser.answer, reasoning: parser.reasoning });
    });
  });
}

/** Finds an executable like a shell would, without running it; honours PATHEXT on Windows. */
function findExecutable(command: string, env: NodeJS.ProcessEnv): boolean {
  const extensions =
    process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  const candidates =
    path.basename(command) !== command
      ? [command]
      : (env.PATH ?? '')
          .split(path.delimiter)
          .filter(Boolean)
          .map((dir) => path.join(dir, command));
  return candidates.some((base) => extensions.some((ext) => isExecutable(base + ext)));
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
