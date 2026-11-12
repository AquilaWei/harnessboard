// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import spawn from 'cross-spawn';
import treeKill from 'tree-kill';
import type { ChildProcess } from 'node:child_process';

/** Owns only the LocalAICLI process it starts; never attaches to an existing service. */
export class LocalAiServer {
  private child: ChildProcess | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private endpoint: string | null = null;
  model: string | null = null;

  constructor(private readonly changed: (error?: string) => void) {}

  /** Owned supervisor PID for local diagnostics; null after reaping. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(command: string, model: string, signal: AbortSignal): Promise<void> {
    if (this.model === model && this.endpoint) return;
    await this.stop();
    signal.throwIfAborted();
    // LocalAICLI rejects port zero and checks ownership of the chosen listener itself.
    const port = await new Promise<number>((resolve, reject) => {
      const reservation = createServer();
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', () => {
        const address = reservation.address();
        reservation.close((error) => {
          if (error) reject(error);
          else if (address && typeof address !== 'string') resolve(address.port);
          else reject(new Error('Cannot allocate a local port'));
        });
      });
    });
    signal.throwIfAborted();
    const child = spawn(command, ['serve', '--model', model, '--port', String(port)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let stderr = '';
      const abort = () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('cancelled while loading model'),
        );
      signal.addEventListener('abort', abort, { once: true });
      child.stderr!.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-4000);
      });
      child.once('error', reject);
      child.once('close', () => {
        signal.removeEventListener('abort', abort);
        if (this.child === child) {
          this.child = null;
          this.endpoint = null;
          this.model = null;
          this.changed(`LocalAICLI service exited: ${stderr}`);
        }
        if (!ready) reject(new Error(`LocalAICLI failed to load: ${stderr}`));
      });
      createInterface({ input: child.stdout! }).on('line', (line) => {
        try {
          const event = JSON.parse(line);
          if (
            event.event === 'ready' &&
            event.host === '127.0.0.1' &&
            Number.isInteger(event.port) &&
            event.port > 0 &&
            event.port <= 65535
          ) {
            this.endpoint = `http://127.0.0.1:${event.port}`;
            this.model = model;
            ready = true;
            signal.removeEventListener('abort', abort);
            resolve();
          }
        } catch {
          /* Runtime diagnostics are not readiness events. */
        }
      });
    });
  }

  async generate(
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ answer: string; reasoning: string }> {
    if (!this.endpoint) throw new Error('LocalAICLI is not loaded');
    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        max_tokens: 2048,
      }),
    });
    if (!response.ok) throw new Error(`LocalAICLI HTTP ${response.status}`);
    const body = (await response.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
    };
    const message = body.choices?.[0]?.message;
    if (typeof message?.content !== 'string') throw new Error('LocalAICLI returned no answer');
    return { answer: message.content, reasoning: message.reasoning_content ?? '' };
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    this.model = null;
    if (!child || child.exitCode !== null) return this.stopping;
    this.stopping = new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        if (child.pid) treeKill(child.pid, 'SIGKILL');
      }, 3000);
      child.once('close', () => {
        clearTimeout(kill);
        resolve();
      });
      if (child.pid) treeKill(child.pid, 'SIGTERM');
    });
    await this.stopping;
  }
}
