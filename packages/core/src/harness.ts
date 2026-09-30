// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { definedOnly, resolveThresholds } from '@harnessboard/shared';
import type {
  AgentEvent,
  CreateTaskInput,
  HarnessEvent,
  HarnessStatus,
  QuotaInfo,
  Task,
  TaskStatus,
  WorktreeDiff,
} from '@harnessboard/shared';
import type { AgentAdapter } from './agent.js';
import { EDITABLE_SETTINGS, loadProjectConfig, saveUserConfig, validate } from './config.js';
import type { EditableSettings, HarnessConfig } from './config.js';
import { runSession } from './runner.js';
import type { SessionOutcome } from './runner.js';
import { dueForRetry, quotaBlocks, startable } from './scheduler.js';
import { Store } from './store.js';
import { Workflow } from './workflow.js';
import type { SessionPlan } from './workflow.js';
import {
  addWorktree,
  branchName,
  currentRef,
  repoRoot,
  worktreeDiff,
  worktreePath,
} from './worktree.js';

/** Git commands a task may run without `skipPermissions`, so it can commit its own work. */
export const DEFAULT_ALLOWED_TOOLS = [
  'Bash(git status)',
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git add *)',
  'Bash(git commit *)',
];

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
  private readonly workflow: Workflow;

  constructor(
    readonly config: HarnessConfig,
    readonly store: Store,
    private readonly adapter: AgentAdapter,
    /** Where runtime setting changes are saved; `null` keeps them in memory (tests). */
    private readonly settingsFile: string | null = null,
  ) {
    this.workflow = new Workflow({
      store,
      config,
      setStatus: (id, status, extra) => this.setStatus(id, status, extra),
      notice: (taskId, message, sessionId) => this.notice(taskId, message, sessionId),
    });
    // Restore the last known quota so a restart does not forget a nearly used-up window.
    const last = store.lastEventOfKind('quota')?.data as { quota?: QuotaInfo } | undefined;
    this.quota = last?.quota ?? null;
  }

  /** Opens the default database under the configured data directory. */
  static open(
    config: HarnessConfig,
    adapter: AgentAdapter,
    settingsFile: string | null = null,
  ): Harness {
    const store = new Store(path.join(config.dataDir, 'harness.db'));
    return new Harness(config, store, adapter, settingsFile);
  }

  settings(): EditableSettings {
    const { maxConcurrent, quotaPauseUtilization, defaultContextPolicy } = this.config;
    return { maxConcurrent, quotaPauseUtilization, defaultContextPolicy };
  }

  /**
   * Applies and saves setting changes. Throws on unknown keys or invalid values,
   * leaving the current settings untouched.
   */
  updateSettings(patch: Partial<EditableSettings>): EditableSettings {
    const unknown = Object.keys(patch).filter(
      (k) => !(EDITABLE_SETTINGS as readonly string[]).includes(k),
    );
    if (unknown.length > 0) throw new Error(`unknown settings: ${unknown.join(', ')}`);
    validate({ ...this.config, ...patch });
    Object.assign(this.config, patch);
    if (this.settingsFile) saveUserConfig(patch, this.settingsFile);
    this.tick(); // a higher concurrency limit may let queued tasks start now
    return this.settings();
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
   * Throws when `repo` is not inside a git repository, the context policy is invalid, or a
   * loop task has no verify command (from the input or the project's config file).
   */
  async createTask(input: CreateTaskInput): Promise<Task> {
    const repoPath = await repoRoot(path.resolve(input.repo));
    const project = loadProjectConfig(repoPath);
    const contextPolicy = {
      ...this.config.defaultContextPolicy,
      ...project.contextPolicy,
      ...definedOnly({ size: input.size, softPct: input.softPct, hardPct: input.hardPct }),
    };
    resolveThresholds(contextPolicy);
    const mode = input.mode ?? 'single';
    const verifyCommand = input.verifyCommand?.trim() || project.verifyCommand || null;
    if (mode === 'loop' && !verifyCommand) {
      throw new Error('a loop task needs a verify command, e.g. "npm test"');
    }
    const allowedTools = input.allowedTools ?? project.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    const task = this.store.createTask({
      title: input.title ?? firstLine(input.prompt),
      prompt: input.prompt,
      repoPath,
      baseRef: input.baseRef ?? project.baseRef ?? (await currentRef(repoPath)),
      mode,
      verifyCommand: mode === 'loop' ? verifyCommand : null,
      contextPolicy,
      permission: {
        // A loop session is told to run the verify command, so it must be allowed to.
        allowedTools:
          mode === 'loop' ? withTool(allowedTools, `Bash(${verifyCommand})`) : allowedTools,
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
    for (const task of dueForRetry(this.store.listTasks(), now)) {
      this.setStatus(task.id, 'queued', { resumeAt: null });
    }
    if (this.quotaBlocked(now)) return;
    const next = startable(this.store.listTasks(), this.running, this.config.maxConcurrent);
    for (const task of next) void this.runTask(task);
  }

  private quotaBlocked(now: number): boolean {
    return quotaBlocks(this.quota, now, this.config.quotaPauseUtilization);
  }

  private async runTask(task: Task): Promise<void> {
    const controller = new AbortController();
    this.running.set(task.id, controller);
    try {
      const ready = await this.ensureWorktree(task);
      const plan = this.workflow.plan(ready);
      const sessionId = plan.resumeId ?? randomUUID();
      if (!plan.resumeId) this.store.startSession(sessionId, task.id);
      this.setStatus(task.id, 'running');
      const outcome = await this.runOne(ready, sessionId, plan, controller.signal);
      this.store.endSession(sessionId, outcome.reason);
      await this.workflow.finish(ready, outcome, controller.signal);
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

  private runOne(
    task: Task,
    sessionId: string,
    plan: SessionPlan,
    signal: AbortSignal,
  ): Promise<SessionOutcome> {
    const window = this.workflow.contextWindow();
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

function withTool(tools: string[], rule: string): string[] {
  return tools.includes(rule) ? tools : [...tools, rule];
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
