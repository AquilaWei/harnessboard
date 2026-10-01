// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_PROVIDERS,
  DEFAULT_PRESET,
  assertToolRules,
  definedOnly,
  isModelId,
  presetRules,
  resolveThresholds,
} from '@harnessboard/shared';
import type {
  AgentEvent,
  AgentInfo,
  AgentProvider,
  AgentsUpdate,
  CommitInfo,
  CreateTaskInput,
  CriteriaApproval,
  CriteriaProposal,
  HarnessEvent,
  FeatureSnapshot,
  HarnessStatus,
  PermissionDecision,
  PermissionDecisionRecord,
  PermissionRequest,
  PlanApproval,
  PlanProposal,
  QuotaInfo,
  ReviewRequest,
  Task,
  TaskActivity,
  TaskAgents,
  TaskStatus,
  WorktreeDiff,
} from '@harnessboard/shared';
import type { AgentAdapter, PermissionReply } from './agent.js';
import {
  DEFAULT_AGENT,
  EDITABLE_SETTINGS,
  loadProjectConfig,
  saveUserConfig,
  validate,
} from './config.js';
import type { EditableSettings, HarnessConfig } from './config.js';
import { resolveRepository } from './folders.js';
import { readPlan } from './loop.js';
import { probe } from './process.js';
import { createAdapter } from './providers.js';
import type { AdapterFactory } from './providers.js';
import { runSession } from './runner.js';
import type { SessionOutcome } from './runner.js';
import { dueForRetry, quotaBlocks, startable } from './scheduler.js';
import { Store } from './store.js';
import { Workflow } from './workflow.js';
import type { SessionPlan } from './workflow.js';
import {
  addWorktree,
  branchName,
  commitDiff,
  commitLog,
  currentRef,
  pruneWorktrees,
  removeWorktree,
  worktreeDiff,
  worktreePath,
} from './worktree.js';

/** Rules a task gets when none are given: the git commands it needs to commit its work. */
export const DEFAULT_ALLOWED_TOOLS = presetRules([DEFAULT_PRESET]);

const TICK_MS = 5_000;
const DEFAULT_REVIEW_ROUNDS = 2;

export interface HarnessOptions {
  /** Where runtime setting changes are saved; omitted keeps them in memory (tests). */
  settingsFile?: string | null;
  /** Builds agent adapters from profiles; tests substitute fake CLIs. */
  adapterFactory?: AdapterFactory;
}
type PermissionRequestEvent = Extract<AgentEvent, { kind: 'permission_request' }>;

interface PendingPermission {
  request: PermissionRequest;
  resolve: (reply: PermissionReply) => void;
}

const STARTABLE: TaskStatus[] = ['backlog', 'stopped', 'failed', 'review', 'waiting_quota'];

/**
 * Owns task lifecycle and scheduling. Single-threaded: all state changes happen on the
 * event loop, and subscribers receive {@link HarnessEvent}s instead of sharing state.
 */
export class Harness {
  private readonly running = new Map<number, AbortController>();
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly quotas = new Map<AgentProvider, QuotaInfo>();
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly activities = new Map<number, TaskActivity>();
  /** Tool uses each running task waits on the user for, by request id. */
  private readonly permissions = new Map<number, Map<string, PendingPermission>>();
  private timer: NodeJS.Timeout | null = null;
  private readonly workflow: Workflow;
  private readonly settingsFile: string | null;
  private readonly adapterFactory: AdapterFactory;

  constructor(
    readonly config: HarnessConfig,
    readonly store: Store,
    options: HarnessOptions = {},
  ) {
    this.settingsFile = options.settingsFile ?? null;
    this.adapterFactory = options.adapterFactory ?? createAdapter;
    this.workflow = new Workflow({
      store,
      config,
      setStatus: (id, status, extra) => this.setStatus(id, status, extra),
      notice: (taskId, message, sessionId) => this.notice(taskId, message, sessionId),
      setActivity: (taskId, activity) => this.setActivity(taskId, activity),
    });
    // Restore the last known quotas so a restart does not forget a nearly used-up window.
    for (const provider of AGENT_PROVIDERS) {
      const event = store.lastAgentEvent('quota', this.profilesOf(provider));
      const quota = (event?.data as { quota?: QuotaInfo } | undefined)?.quota;
      if (quota) this.quotas.set(provider, quota);
    }
  }

  /** Opens the default database under the configured data directory. */
  static open(config: HarnessConfig, options: HarnessOptions = {}): Harness {
    const store = new Store(path.join(config.dataDir, 'harness.db'));
    return new Harness(config, store, options);
  }

  /** The adapter for an agent profile. Throws when the profile is not configured. */
  adapterFor(agentId: string): AgentAdapter {
    let adapter = this.adapters.get(agentId);
    if (!adapter) {
      const profile = this.config.agents[agentId];
      if (!profile) throw new Error(`agent profile "${agentId}" is not configured`);
      adapter = this.adapterFactory(profile);
      this.adapters.set(agentId, adapter);
    }
    return adapter;
  }

  /** Runs every profile's version command; a profile whose CLI fails is reported, not thrown. */
  async probeAgents(): Promise<AgentInfo[]> {
    return Promise.all(
      Object.entries(this.config.agents).map(async ([id, profile]) => {
        const adapter = this.adapterFor(id);
        try {
          const version = await probe(adapter.command, adapter.versionArgs);
          return { id, profile, ok: true, version, error: null };
        } catch (err) {
          return { id, profile, ok: false, version: null, error: (err as Error).message };
        }
      }),
    );
  }

  /** What a running task is doing right now; `null` when it is not running. */
  activity(taskId: number): TaskActivity | null {
    return this.activities.get(taskId) ?? null;
  }

  /** The user's reply to a plan that the planner has not handled yet. */
  pendingPlanFeedback(taskId: number): string | null {
    return this.workflow.pendingPlanFeedback(taskId);
  }

  /** The review a task is waiting for, if its latest step has not been reviewed yet. */
  pendingReview(taskId: number): ReviewRequest | null {
    return this.workflow.pendingReview(taskId);
  }

  /** Tool uses a running task waits on the user to allow or deny, oldest first. */
  permissionRequests(taskId: number): PermissionRequest[] {
    return [...(this.permissions.get(taskId)?.values() ?? [])].map((p) => p.request);
  }

  /**
   * Answers a tool use the agent is waiting on. Allowing with `rules` also adds them to the
   * task, so this and later sessions use them without asking. The task goes back to
   * `running` once nothing else is waiting. Throws when the request is not pending or a
   * rule is invalid; nothing is answered then.
   */
  answerPermission(id: number, decision: PermissionDecision): Task {
    const task = this.requireTask(id);
    const pending = this.permissions.get(id)?.get(decision.requestId);
    if (!pending)
      throw new Error(`task ${id} has no pending permission request ${decision.requestId}`);
    const allow = decision.behavior === 'allow';
    const rules = allow
      ? [...new Set((decision.rules ?? []).map((r) => r.trim()).filter(Boolean))]
      : [];
    assertToolRules(rules);
    if (rules.length > 0) {
      const allowedTools = rules.reduce(withTool, task.permission.allowedTools);
      this.store.updateTask(id, { permission: { ...task.permission, allowedTools } });
    }
    const message = allow ? null : decision.message?.trim() || null;
    this.settlePermission(id, pending, {
      behavior: decision.behavior,
      rules,
      message,
      auto: false,
    });
    return this.requireTask(id);
  }

  settings(): EditableSettings {
    const { maxConcurrent, quotaPauseUtilization, defaultContextPolicy, defaultReviewer } =
      this.config;
    return { maxConcurrent, quotaPauseUtilization, defaultContextPolicy, defaultReviewer };
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
   * Starts periodic scheduling. Tasks left `running` or `awaiting_permission` by a previous
   * process that died are re-queued, because their agent process no longer exists.
   */
  start(): void {
    for (const task of this.store.listTasks()) {
      // A task that waited for permission asks again once its session resumes.
      if (task.status === 'running' || task.status === 'awaiting_permission') {
        this.setStatus(task.id, 'queued');
      }
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
   * Throws when `repo` is missing, not inside a git repository with a commit, the context policy is invalid, a
   * loop task has no verify command (from the input or the project's config file), an
   * allowed-tools entry is not a tool rule, or an agent profile or model id is invalid.
   */
  async createTask(input: CreateTaskInput): Promise<Task> {
    const repoPath = await resolveRepository(input.repo);
    const project = loadProjectConfig(repoPath);
    const contextPolicy = {
      ...this.config.defaultContextPolicy,
      ...project.contextPolicy,
      ...definedOnly({ size: input.size, softPct: input.softPct, hardPct: input.hardPct }),
    };
    resolveThresholds(contextPolicy);
    const mode = input.mode ?? 'single';
    const verifyCommand = input.verifyCommand?.trim() || project.verifyCommand || null;
    const acceptance = optionalText(input.acceptance, 'acceptance')?.trim() || null;
    // With plan approval the command can be chosen (or taken from the planner) at approval.
    // A single task without criteria agrees on them with the user first.
    const confirmPlan = input.confirmPlan ?? (mode === 'loop' || !acceptance);
    if (mode === 'loop' && !confirmPlan && !verifyCommand) {
      throw new Error(
        'a loop task that starts without plan approval needs a verify command, e.g. "npm test"',
      );
    }
    const allowedTools = input.allowedTools ?? project.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    assertToolRules(allowedTools);
    const agents: TaskAgents = {
      implementer: input.implementer ?? DEFAULT_AGENT,
      reviewer: input.reviewer === undefined ? this.config.defaultReviewer : input.reviewer,
      maxReviewRounds: DEFAULT_REVIEW_ROUNDS,
      implementerModel: modelOrNull(input.implementerModel),
      reviewerModel: modelOrNull(input.reviewerModel),
    };
    this.checkProfiles(agents);
    const task = this.store.createTask({
      title: input.title ?? firstLine(input.prompt),
      prompt: input.prompt,
      repoPath,
      baseRef: input.baseRef ?? project.baseRef ?? (await currentRef(repoPath)),
      mode,
      verifyCommand: mode === 'loop' ? verifyCommand : null,
      acceptance,
      confirmPlan,
      contextPolicy,
      permission: {
        // A loop session is told to run the verify command, so it must be allowed to.
        allowedTools:
          mode === 'loop' && verifyCommand
            ? withTool(allowedTools, `Bash(${verifyCommand})`)
            : allowedTools,
        skipPermissions: input.skipPermissions ?? false,
      },
      agents,
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
      this.dropPermissions(id);
      return task;
    }
    if (task.status === 'queued' || task.status === 'waiting_quota') {
      return this.setStatus(id, 'stopped', { resumeAt: null });
    }
    return task;
  }

  /**
   * Changes who works on a task and with which models; fields left out stay as they are.
   * Takes effect from its next session. Throws when the task is running, a profile is not
   * configured or a model id is invalid.
   */
  setAgents(id: number, update: AgentsUpdate): Task {
    const task = this.requireTask(id);
    if (this.running.has(id) || task.status === 'running') {
      throw new Error(`task ${id} is running; stop it before changing its agents`);
    }
    const agents: TaskAgents = { ...task.agents };
    if (update.implementer !== undefined) agents.implementer = update.implementer;
    if (update.reviewer !== undefined) agents.reviewer = update.reviewer;
    if (update.implementerModel !== undefined) {
      agents.implementerModel = modelOrNull(update.implementerModel);
    }
    if (update.reviewerModel !== undefined)
      agents.reviewerModel = modelOrNull(update.reviewerModel);
    this.checkProfiles(agents);
    const updated = this.store.updateTask(id, { agents });
    this.emit({ type: 'task', taskId: id, status: updated.status });
    return updated;
  }

  /**
   * Replaces the tool rules of a task, e.g. to fix rules that kept it from working. Takes
   * effect from its next session. Throws when the task is running or a rule is invalid.
   */
  setAllowedTools(id: number, rules: string[]): Task {
    const task = this.requireTask(id);
    if (this.running.has(id) || task.status === 'running') {
      throw new Error(`task ${id} is running; stop it before changing its tools`);
    }
    const unique = [...new Set(rules.map((rule) => rule.trim()).filter(Boolean))];
    assertToolRules(unique);
    const updated = this.store.updateTask(id, {
      permission: { ...task.permission, allowedTools: unique },
    });
    this.emit({ type: 'task', taskId: id, status: updated.status });
    return updated;
  }

  /**
   * Deletes a task with its history and removes its worktree directory, discarding any
   * uncommitted changes there. The branch is kept, so committed work can still be merged.
   * Throws when the task is missing or running (stop it first), or git cannot remove the
   * worktree; the task is then left as it was.
   */
  async deleteTask(id: number): Promise<void> {
    const task = this.requireTask(id);
    if (this.running.has(id) || task.status === 'running') {
      throw new Error(`task ${id} is running; stop it before deleting`);
    }
    // Take it out of the queue first so the scheduler cannot start it while git works.
    if (task.status === 'queued' || task.status === 'waiting_quota') {
      this.setStatus(id, 'stopped', { resumeAt: null });
    }
    if (task.worktreePath) await this.discardWorktree(task.repoPath, task.worktreePath);
    this.store.deleteTask(id);
    this.emit({ type: 'deleted', taskId: id });
  }

  /**
   * Sends the user's reply on a proposed plan (a loop task's features or a single task's
   * acceptance criteria) back to the agent, which revises it in the same conversation.
   * Throws unless the task is waiting for approval.
   */
  planFeedback(id: number, message: string): Task {
    const task = this.requireTask(id);
    if (task.status !== 'awaiting_approval') {
      throw new Error(`task ${id} is ${task.status}, not waiting for plan approval`);
    }
    if (!message.trim()) throw new Error('feedback is empty');
    this.store.appendEvent(id, null, 'plan_feedback', { message: message.trim() });
    const queued = this.setStatus(id, 'queued');
    this.tick();
    return queued;
  }

  /**
   * Approves the plan as it is in the worktree now (it may have been changed in an
   * interactive session) and starts building. The verify command is the given one or the
   * task's own; the planner's suggestion is never used unless the user passes it here.
   * Throws when the task is not waiting for approval, no command is given, or the feature
   * list is invalid.
   */
  approvePlan(id: number, verifyCommand?: string): Task {
    const task = this.requireTask(id);
    if (task.status !== 'awaiting_approval') {
      throw new Error(`task ${id} is ${task.status}, not waiting for plan approval`);
    }
    const command = verifyCommand?.trim() || task.verifyCommand;
    if (!command) {
      const proposal = this.store.lastEvent(id, 'plan')?.data as PlanProposal | undefined;
      const hint = proposal?.suggestedVerify
        ? `; the planner suggested: ${proposal.suggestedVerify}`
        : '';
      throw new Error(`choose a verify command to start building${hint}`);
    }
    const { features } = readPlan(task.worktreePath!);
    const others = task.permission.allowedTools.filter(
      (rule) => rule !== `Bash(${task.verifyCommand})`,
    );
    this.store.updateTask(id, {
      verifyCommand: command,
      permission: { ...task.permission, allowedTools: withTool(others, `Bash(${command})`) },
    });
    const approval: PlanApproval = { verifyCommand: command, features };
    this.store.appendEvent(id, null, 'plan_approved', approval);
    // The approved list is the baseline later sessions may not drop features from.
    const baseline: FeatureSnapshot = { features, verify: null, verifiedPassing: 0 };
    this.store.appendEvent(id, null, 'features', baseline);
    this.notice(id, `plan approved: ${features.length} features, verify with ${command}`);
    const queued = this.setStatus(id, 'queued');
    this.tick();
    return queued;
  }

  /**
   * Approves a single task's acceptance criteria and lets its agent start changing files.
   * `criteria` replaces the proposed ones, e.g. after the user edited them. Throws when the
   * task is not a single task waiting for approval, or there are no criteria to approve.
   */
  approveCriteria(id: number, criteria?: string): Task {
    const task = this.requireTask(id);
    if (task.mode !== 'single' || task.status !== 'awaiting_approval') {
      throw new Error(`task ${id} is not waiting for its acceptance criteria to be approved`);
    }
    const agreed =
      optionalText(criteria, 'criteria')?.trim() || this.workflow.criteriaProposal(task)?.criteria;
    if (!agreed) throw new Error('write the acceptance criteria to approve');
    this.store.updateTask(id, { acceptance: agreed });
    const approval: CriteriaApproval = { criteria: agreed };
    this.store.appendEvent(id, null, 'criteria_approved', approval);
    this.notice(id, 'acceptance criteria approved; starting work');
    const queued = this.setStatus(id, 'queued');
    this.tick();
    return queued;
  }

  /** Latest proposed criteria of a single task, until they are approved. */
  criteriaProposal(task: Task): CriteriaProposal | null {
    return this.workflow.criteriaProposal(task);
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

  /** Commits on the task's branch since its base, newest first; none before it has a worktree. */
  async commits(id: number): Promise<CommitInfo[]> {
    const task = this.requireTask(id);
    if (!task.worktreePath) return [];
    return commitLog(task.worktreePath, task.baseRef);
  }

  /**
   * One commit of the task's branch as `git show` prints it. Only commits from
   * {@link commits} are accepted, so the caller cannot read other refs or pass git options.
   */
  async commitDiff(id: number, hash: string): Promise<string> {
    const task = this.requireTask(id);
    const known = (await this.commits(id)).some((c) => c.hash === hash);
    if (!known) throw new Error(`commit ${hash} is not on task ${id}'s branch`);
    return commitDiff(task.worktreePath!, hash);
  }

  status(): HarnessStatus {
    return {
      running: [...this.running.keys()],
      quotas: Object.fromEntries(this.quotas),
      quotaPaused: AGENT_PROVIDERS.filter((p) => this.quotaBlocked(p, Date.now())),
      maxConcurrent: this.config.maxConcurrent,
      configFile: this.settingsFile,
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
    // A task waits only when the provider of its next session is short of quota.
    const ready = this.store
      .listTasks()
      .filter((t) => t.status !== 'queued' || !this.nextSessionBlocked(t, now));
    const next = startable(ready, this.running, this.config.maxConcurrent);
    for (const task of next) void this.runTask(task);
  }

  private nextSessionBlocked(task: Task, now: number): boolean {
    const profile = this.config.agents[this.workflow.nextAgentId(task)];
    return profile !== undefined && this.quotaBlocked(profile.provider, now);
  }

  private quotaBlocked(provider: AgentProvider, now: number): boolean {
    const quota = this.quotas.get(provider) ?? null;
    return quotaBlocks(quota, now, this.config.quotaPauseUtilization);
  }

  private profilesOf(provider: AgentProvider): string[] {
    return Object.entries(this.config.agents)
      .filter(([, profile]) => profile.provider === provider)
      .map(([id]) => id);
  }

  private async runTask(task: Task): Promise<void> {
    const controller = new AbortController();
    this.running.set(task.id, controller);
    try {
      const ready = await this.ensureWorktree(task);
      const plan = this.workflow.plan(ready);
      const adapter = this.adapterFor(plan.agentId);
      const sessionId = plan.resume?.id ?? randomUUID();
      if (!plan.resume) {
        // CLIs that assign their own ids report them in `init`; see runOne.
        const agentSessionId = adapter.capabilities.sessionIds === 'harness' ? sessionId : null;
        this.store.startSession(sessionId, task.id, plan.role, plan.agentId, agentSessionId);
      }
      this.setActivity(task.id, this.workflow.phaseOf(ready, plan));
      this.setStatus(task.id, 'running');
      const outcome = await this.runOne(ready, sessionId, plan, adapter, controller.signal);
      this.store.endSession(sessionId, outcome.reason);
      await this.workflow.finish(ready, plan, outcome, controller.signal);
    } catch (err) {
      this.notice(task.id, `task failed: ${(err as Error).message}`);
      this.setStatus(task.id, 'failed');
    } finally {
      this.dropPermissions(task.id);
      this.running.delete(task.id);
      this.activities.delete(task.id);
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

  private async discardWorktree(repo: string, dir: string): Promise<void> {
    if (!existsSync(repo)) {
      // Without its repository git cannot remove the worktree; the folder is ours to delete.
      await rm(dir, { recursive: true, force: true });
    } else if (existsSync(dir)) {
      await removeWorktree(repo, dir);
    } else {
      await pruneWorktrees(repo);
    }
  }

  private runOne(
    task: Task,
    sessionId: string,
    plan: SessionPlan,
    adapter: AgentAdapter,
    signal: AbortSignal,
  ): Promise<SessionOutcome> {
    const window = this.workflow.contextWindow(plan.agentId);
    const provider = adapter.provider;
    let tokens = 0;
    return runSession({
      adapter,
      spec: {
        cwd: task.worktreePath!,
        sessionId: plan.resume
          ? plan.resume.agentSessionId
          : adapter.capabilities.sessionIds === 'harness'
            ? sessionId
            : null,
        resume: plan.resume !== null,
        prompt: plan.prompt,
        model:
          (plan.role === 'reviewer' ? task.agents.reviewerModel : task.agents.implementerModel) ??
          this.config.agents[plan.agentId]!.model,
        access: plan.access,
        // A read-only session may run the task's own check, but nothing that edits.
        allowedTools:
          plan.access === 'readOnly'
            ? task.verifyCommand
              ? [`Bash(${task.verifyCommand})`]
              : []
            : task.permission.allowedTools,
        skipPermissions: task.permission.skipPermissions,
        // Read-only sessions must not change anything, so they are never offered more tools.
        askPermission: plan.access === 'edit' && adapter.capabilities.permissionPrompts,
      },
      thresholds: resolveThresholds(task.contextPolicy),
      // A read-only session has nothing to commit or hand off; it only stops at the hard limit.
      wrapUp: plan.access === 'edit',
      contextWindow: window,
      signal,
      onEvent: (event) => {
        if (event.kind === 'init' && event.sessionId) {
          this.store.setAgentSessionId(sessionId, event.sessionId);
        }
        if (event.kind === 'context') {
          tokens = event.tokens;
          this.store.updateSessionContext(sessionId, tokens, null);
        }
        // Only a window the agent reported is stored; the fallback is a guess.
        if (event.kind === 'result' && event.contextWindow) {
          this.store.updateSessionContext(sessionId, tokens, event.contextWindow);
        }
        this.recordAgentEvent(task.id, sessionId, provider, event);
      },
      onPermissionRequest: (event) => this.askPermission(task.id, sessionId, event),
      onNotice: (message) => this.notice(task.id, message, sessionId),
      onStderr: (line) => this.store.appendEvent(task.id, sessionId, 'stderr', { line }),
    });
  }

  /**
   * Allows a tool use the task's rules already cover (they may have been added earlier in
   * this session, after the CLI started); otherwise records it and waits for the user.
   */
  private askPermission(
    taskId: number,
    sessionId: string,
    event: PermissionRequestEvent,
  ): Promise<PermissionReply> {
    const { requestId, toolName, summary, suggestedRules } = event;
    const request: PermissionRequest = {
      requestId,
      sessionId,
      toolName,
      summary,
      suggestedRules,
      ts: Date.now(),
    };
    const allowed = this.requireTask(taskId).permission.allowedTools;
    if (suggestedRules.length > 0 && suggestedRules.every((rule) => allowed.includes(rule))) {
      this.recordDecision(taskId, request, {
        behavior: 'allow',
        rules: [],
        message: null,
        auto: true,
      });
      return Promise.resolve({ behavior: 'allow' });
    }
    return new Promise((resolve) => {
      let waiting = this.permissions.get(taskId);
      if (!waiting) this.permissions.set(taskId, (waiting = new Map()));
      waiting.set(requestId, { request, resolve });
      this.store.appendEvent(taskId, sessionId, 'permission_request', request);
      this.setStatus(taskId, 'awaiting_permission');
    });
  }

  private settlePermission(
    taskId: number,
    pending: PendingPermission,
    outcome: Omit<PermissionDecisionRecord, 'requestId' | 'toolName' | 'summary'>,
  ): void {
    const waiting = this.permissions.get(taskId);
    waiting?.delete(pending.request.requestId);
    this.recordDecision(taskId, pending.request, outcome);
    pending.resolve(
      outcome.behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', ...(outcome.message ? { message: outcome.message } : {}) },
    );
    if (waiting?.size === 0 && this.running.has(taskId)) this.setStatus(taskId, 'running');
  }

  private recordDecision(
    taskId: number,
    request: PermissionRequest,
    outcome: Omit<PermissionDecisionRecord, 'requestId' | 'toolName' | 'summary'>,
  ): void {
    const { requestId, toolName, summary } = request;
    const record: PermissionDecisionRecord = { requestId, toolName, summary, ...outcome };
    this.store.appendEvent(taskId, request.sessionId, 'permission_decision', record);
    this.emit({ type: 'task', taskId, status: this.requireTask(taskId).status });
  }

  /** Denies whatever a task still waits on, e.g. when it is stopped; the agent is ending. */
  private dropPermissions(taskId: number): void {
    const waiting = this.permissions.get(taskId);
    if (!waiting) return;
    this.permissions.delete(taskId);
    for (const pending of waiting.values()) {
      pending.resolve({ behavior: 'deny', message: 'The task was stopped.' });
    }
  }

  private recordAgentEvent(
    taskId: number,
    sessionId: string,
    provider: AgentProvider,
    event: AgentEvent,
  ): void {
    // A permission request is recorded by askPermission, without the tool's full input.
    if (event.kind !== 'permission_request') {
      this.store.appendEvent(taskId, sessionId, event.kind, event);
    }
    if (event.kind === 'quota') this.quotas.set(provider, event.quota);
    this.emit({ type: 'agent', taskId, sessionId, event });
  }

  private checkProfiles(agents: TaskAgents): void {
    for (const id of [agents.implementer, agents.reviewer]) {
      if (id !== null && !this.config.agents[id]) {
        throw new Error(`agent profile "${id}" is not configured`);
      }
    }
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

  private setActivity(taskId: number, activity: TaskActivity): void {
    this.activities.set(taskId, activity);
    this.emit({ type: 'task', taskId, status: 'running' });
  }

  private notice(taskId: number, message: string, sessionId: string | null = null): void {
    this.store.appendEvent(taskId, sessionId, 'notice', { message });
    this.emit({ type: 'harness', taskId, message });
  }

  private emit(event: HarnessEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** A trimmed model id, or `null` for empty; throws on anything that is not a model id. */
function modelOrNull(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) return null;
  if (!isModelId(trimmed)) {
    throw new Error(`"${trimmed}" is not a model id; use e.g. opus, sonnet or claude-opus-5-5`);
  }
  return trimmed;
}

function withTool(tools: string[], rule: string): string[] {
  return tools.includes(rule) ? tools : [...tools, rule];
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** Checks a field that arrives from JSON; throws when it is set but not a string. */
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be text`);
  return value;
}
