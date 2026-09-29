// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { contextPct, resolveThresholds } from '@harnessboard/shared';
import type {
  AgentEvent,
  HarnessEvent,
  QuotaInfo,
  Session,
  Task,
  TaskSize,
  TaskStatus,
} from '@harnessboard/shared';
import type { AgentAdapter } from './agent.js';
import { loadProjectConfig } from './config.js';
import type { HarnessConfig } from './config.js';
import { QUOTA_RESUME_PROMPT, continuationPrompt } from './prompts.js';
import { isQuotaLimited, runSession } from './runner.js';
import type { SessionOutcome } from './runner.js';
import { Store } from './store.js';
import {
  addWorktree,
  branchName,
  currentRef,
  repoRoot,
  worktreeDiff,
  worktreePath,
} from './worktree.js';
import type { WorktreeDiff } from './worktree.js';

/** Git commands a task may run without `skipPermissions`, so it can commit its own work. */
export const DEFAULT_ALLOWED_TOOLS = [
  'Bash(git status)',
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git add *)',
  'Bash(git commit *)',
];

export interface CreateTaskInput {
  prompt: string;
  /** Any directory inside the target repository. */
  repo: string;
  title?: string;
  baseRef?: string;
  size?: TaskSize;
  softPct?: number;
  hardPct?: number;
  allowedTools?: string[];
  skipPermissions?: boolean;
  /** Queue immediately instead of leaving the task in the backlog. */
  queue?: boolean;
}

export interface HarnessStatus {
  running: number[];
  quota: QuotaInfo | null;
  /** True while the scheduler holds back new sessions because of quota. */
  quotaPaused: boolean;
  maxConcurrent: number;
}

/** How the next session of a task starts. */
type SessionPlan = { resumeId: string | null; prompt: string };

const TICK_MS = 5_000;
const STARTABLE: TaskStatus[] = ['backlog', 'stopped', 'failed', 'review', 'waiting_quota'];

/**
 * Owns task lifecycle and scheduling. Single-threaded: all state changes happen on the
 * event loop, and subscribers receive {@link HarnessEvent}s instead of sharing state.
 */
export class Harness {
  private readonly running = new Map<number, AbortController>();
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private quota: QuotaInfo | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly config: HarnessConfig,
    readonly store: Store,
    private readonly adapter: AgentAdapter,
  ) {}

  /** Opens the default database under the configured data directory. */
  static open(config: HarnessConfig, adapter: AgentAdapter): Harness {
    return new Harness(config, new Store(path.join(config.dataDir, 'harness.db')), adapter);
  }

  /**
   * Starts periodic scheduling. Tasks left `running` by a previous process that died are
   * re-queued, because their agent process no longer exists.
   */
  start(): void {
    for (const task of this.store.listTasks()) {
      if (task.status === 'running') this.setStatus(task.id, 'queued');
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  /** Stops scheduling and every running session; resolves once they have ended. */
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const ids = [...this.running.keys()];
    for (const controller of this.running.values()) controller.abort();
    await this.waitForIdle(ids);
  }

  subscribe(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Validates the repository and thresholds, then records the task.
   * Throws when `repo` is not inside a git repository or the context policy is invalid.
   */
  async createTask(input: CreateTaskInput): Promise<Task> {
    const repoPath = await repoRoot(path.resolve(input.repo));
    const project = loadProjectConfig(repoPath);
    const contextPolicy = {
      ...project.contextPolicy,
      ...definedOnly({ size: input.size, softPct: input.softPct, hardPct: input.hardPct }),
    };
    resolveThresholds(contextPolicy);
    const task = this.store.createTask({
      title: input.title ?? firstLine(input.prompt),
      prompt: input.prompt,
      repoPath,
      baseRef: input.baseRef ?? project.baseRef ?? (await currentRef(repoPath)),
      contextPolicy,
      permission: {
        allowedTools: input.allowedTools ?? project.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
        skipPermissions: input.skipPermissions ?? false,
      },
    });
    this.emit({ type: 'task', taskId: task.id, status: task.status });
    if (input.queue) return this.queueTask(task.id);
    return task;
  }

  /** Puts a task in line to run. Throws when it is missing, running, queued or done. */
  queueTask(id: number): Task {
    const task = this.requireTask(id);
    if (!STARTABLE.includes(task.status)) {
      throw new Error(`task ${id} is ${task.status} and cannot be queued`);
    }
    const queued = this.setStatus(id, 'queued', { resumeAt: null });
    this.tick();
    return queued;
  }

  /** Stops a running or queued task. The worktree and branch are kept. */
  stopTask(id: number): Task {
    const task = this.requireTask(id);
    const controller = this.running.get(id);
    if (controller) {
      controller.abort(); // the session's completion handler records the `stopped` status
      return task;
    }
    if (task.status === 'queued' || task.status === 'waiting_quota') {
      return this.setStatus(id, 'stopped', { resumeAt: null });
    }
    return task;
  }

  /** Marks a reviewed task as done. */
  completeTask(id: number): Task {
    const task = this.requireTask(id);
    if (task.status !== 'review') throw new Error(`task ${id} is ${task.status}, not review`);
    return this.setStatus(id, 'done');
  }

  async diff(id: number): Promise<WorktreeDiff> {
    const task = this.requireTask(id);
    if (!task.worktreePath) return { diff: '', untracked: [] };
    return worktreeDiff(task.worktreePath, task.baseRef);
  }

  status(): HarnessStatus {
    return {
      running: [...this.running.keys()],
      quota: this.quota,
      quotaPaused: this.quotaBlocked(Date.now()),
      maxConcurrent: this.config.maxConcurrent,
    };
  }

  /** Resolves once none of `ids` is running any more. */
  async waitForIdle(ids: number[] = [...this.running.keys()]): Promise<void> {
    while (ids.some((id) => this.running.has(id))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Starts queued tasks up to the concurrency limit and wakes quota-paused ones. */
  tick(now = Date.now()): void {
    for (const task of this.store.listTasks()) {
      if (task.status === 'waiting_quota' && task.resumeAt !== null && task.resumeAt <= now) {
        this.setStatus(task.id, 'queued', { resumeAt: null });
      }
    }
    if (this.quotaBlocked(now)) return;
    const queued = this.store.listTasks().filter((t) => t.status === 'queued');
    for (const task of queued) {
      if (this.running.size >= this.config.maxConcurrent) break;
      // Still `queued` in the store until its worktree is ready; don't start it twice.
      if (this.running.has(task.id)) continue;
      void this.runTask(task);
    }
  }

  private quotaBlocked(now: number): boolean {
    const q = this.quota;
    if (!q) return false;
    if (q.resetsAt !== null && q.resetsAt <= now) return false; // window has rolled over
    if (isQuotaLimited(q)) return true;
    return (q.fiveHourUtilization ?? 0) >= this.config.quotaPauseUtilization;
  }

  private async runTask(task: Task): Promise<void> {
    const controller = new AbortController();
    this.running.set(task.id, controller);
    try {
      const ready = await this.ensureWorktree(task);
      const plan = this.planSession(ready);
      const sessionId = plan.resumeId ?? randomUUID();
      if (!plan.resumeId) this.store.startSession(sessionId, task.id);
      this.setStatus(task.id, 'running');
      const outcome = await this.runOne(ready, sessionId, plan, controller.signal);
      this.store.endSession(sessionId, outcome.reason);
      this.applyOutcome(ready, outcome);
    } catch (err) {
      this.notice(task.id, `task failed: ${(err as Error).message}`);
      this.setStatus(task.id, 'failed');
    } finally {
      this.running.delete(task.id);
      if (this.timer) this.tick();
    }
  }

  private async ensureWorktree(task: Task): Promise<Task> {
    if (task.worktreePath) return task;
    const branch = branchName(task.id, task.title);
    const dir = worktreePath(this.config.dataDir, task.repoPath, task.id);
    await addWorktree(task.repoPath, dir, branch, task.baseRef);
    return this.store.updateTask(task.id, { branch, worktreePath: dir });
  }

  /**
   * Fresh session for a new task or after a handoff; `--resume` of the previous session
   * after a quota pause, stop or error, but only while that session still has budget.
   */
  private planSession(task: Task): SessionPlan {
    const last = this.store.listSessions(task.id).at(-1);
    if (!last) return { resumeId: null, prompt: task.prompt };
    const continuation = () => {
      const note = this.store.lastEvent(task.id, 'handoff')?.data as { note?: string } | undefined;
      return { resumeId: null, prompt: continuationPrompt(task.prompt, note?.note ?? null) };
    };
    if (last.endReason === 'handoff' || last.endReason === 'context_hard_limit') {
      return continuation();
    }
    return this.hasBudget(task, last)
      ? { resumeId: last.id, prompt: QUOTA_RESUME_PROMPT }
      : continuation();
  }

  private hasBudget(task: Task, session: Session): boolean {
    const window = session.contextWindow ?? this.contextWindow();
    return (
      contextPct(session.contextTokens, window) < resolveThresholds(task.contextPolicy).softPct
    );
  }

  private contextWindow(): number {
    return this.store.lastKnownContextWindow() ?? this.config.fallbackContextWindow;
  }

  private runOne(
    task: Task,
    sessionId: string,
    plan: SessionPlan,
    signal: AbortSignal,
  ): Promise<SessionOutcome> {
    const window = this.contextWindow();
    let tokens = 0;
    return runSession({
      adapter: this.adapter,
      spec: {
        cwd: task.worktreePath!,
        sessionId,
        resume: plan.resumeId !== null,
        model: this.config.model,
        allowedTools: task.permission.allowedTools,
        skipPermissions: task.permission.skipPermissions,
      },
      prompt: plan.prompt,
      thresholds: resolveThresholds(task.contextPolicy),
      contextWindow: window,
      signal,
      onEvent: (event) => {
        if (event.kind === 'context') {
          tokens = event.tokens;
          this.store.updateSessionContext(sessionId, tokens, null);
        }
        // Only a window the agent reported is stored; the fallback is a guess.
        if (event.kind === 'result' && event.contextWindow) {
          this.store.updateSessionContext(sessionId, tokens, event.contextWindow);
        }
        this.recordAgentEvent(task.id, sessionId, event);
      },
      onNotice: (message) => this.notice(task.id, message, sessionId),
      onStderr: (line) => this.store.appendEvent(task.id, sessionId, 'stderr', { line }),
    });
  }

  private recordAgentEvent(taskId: number, sessionId: string, event: AgentEvent): void {
    this.store.appendEvent(taskId, sessionId, event.kind, event);
    if (event.kind === 'quota') this.quota = event.quota;
    this.emit({ type: 'agent', taskId, sessionId, event });
  }

  private applyOutcome(task: Task, outcome: SessionOutcome): void {
    this.notice(
      task.id,
      `session ended: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ''}`,
    );
    switch (outcome.reason) {
      case 'completed':
        this.setStatus(task.id, 'review');
        return;
      case 'handoff':
      case 'context_hard_limit':
        this.handOff(task, outcome);
        return;
      case 'quota': {
        const resumeAt =
          outcome.quota?.resetsAt ?? Date.now() + this.config.quotaRetryMinutes * 60_000;
        this.setStatus(task.id, 'waiting_quota', { resumeAt });
        return;
      }
      case 'stopped':
        this.setStatus(task.id, 'stopped');
        return;
      case 'error':
        this.setStatus(task.id, 'failed');
        return;
    }
  }

  private handOff(task: Task, outcome: SessionOutcome): void {
    const note = outcome.reason === 'handoff' && outcome.finalText ? outcome.finalText : null;
    this.store.appendEvent(task.id, null, 'handoff', { note });
    const handoffs = this.store
      .listSessions(task.id)
      .filter((s) => s.endReason === 'handoff' || s.endReason === 'context_hard_limit').length;
    if (handoffs >= this.config.maxHandoffs) {
      this.notice(task.id, `reached ${handoffs} handoffs (maxHandoffs); stopping for review`);
      this.setStatus(task.id, 'failed');
      return;
    }
    this.setStatus(task.id, 'queued');
  }

  private requireTask(id: number): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`task ${id} not found`);
    return task;
  }

  private setStatus(
    id: number,
    status: TaskStatus,
    extra: { resumeAt?: number | null } = {},
  ): Task {
    const task = this.store.updateTask(id, { status, ...extra });
    this.emit({ type: 'task', taskId: id, status });
    return task;
  }

  private notice(taskId: number, message: string, sessionId: string | null = null): void {
    this.store.appendEvent(taskId, sessionId, 'notice', { message });
    this.emit({ type: 'harness', taskId, message });
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function definedOnly<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
