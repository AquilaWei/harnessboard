// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_PROVIDERS,
  DEFAULT_COMMANDS,
  DEFAULT_PRESET,
  assertToolRules,
  contextPct,
  definedOnly,
  isEffortId,
  isModelId,
  isProfileId,
  presetRules,
  resolveThresholds,
  roleEffort,
  roleModel,
} from '@harnessboard/shared';
import type {
  AgentEffortUpdate,
  AgentEvent,
  AgentInfo,
  AgentProfile,
  AgentProvider,
  AgentRole,
  DetectedAgent,
  ModelInfo,
  NewAgentProfile,
  Session,
  AgentsUpdate,
  ChatEnd,
  ChatMessage,
  ChatQueueCleared,
  ChatQueued,
  CommitInfo,
  CommitSpan,
  CreateTaskInput,
  CriteriaApproval,
  CriteriaProposal,
  MergeConflict,
  MergeRecord,
  MergeResult,
  HarnessEvent,
  FeatureSnapshot,
  HarnessStatus,
  PermissionDecision,
  PermissionDecisionRecord,
  PermissionRequest,
  PlanApproval,
  PlanProposal,
  QuotaInfo,
  UsageRecord,
  ReviewRequest,
  SpecChangeProposal,
  SpecRevisionRequest,
  Task,
  TaskActivity,
  TaskAgents,
  TaskNotes,
  TaskStatus,
  WorktreeDiff,
} from '@harnessboard/shared';
import type { AgentAdapter, PermissionReply } from './agent.js';
import { matchingCodexRules } from './codex-app-server.js';
import {
  DEFAULT_AGENT,
  EDITABLE_SETTINGS,
  loadProjectConfig,
  saveUserAgent,
  saveUserAgentEffort,
  withEffort,
  saveUserConfig,
  validate,
} from './config.js';
import type { EditableSettings, HarnessConfig } from './config.js';
import { resolveRepository } from './folders.js';
import { readGuidelines } from './guidelines.js';
import { readPlan } from './loop.js';
import { copyNotes } from './notes.js';
import { probe } from './process.js';
import { createAdapter } from './providers.js';
import type { AdapterFactory } from './providers.js';
import { reviewEvidence } from './review.js';
import { runSession } from './runner.js';
import type { SessionOutcome } from './runner.js';
import { dueForRetry, quotaBlocks, startable } from './scheduler.js';
import { Store } from './store.js';
import { riskOf } from './risk.js';
import { Workflow } from './workflow.js';
import type { SessionPlan } from './workflow.js';
import {
  addWorktree,
  advanceBranch,
  branchName,
  commitDiff,
  commitLog,
  commitRange,
  commitTree,
  currentRef,
  deleteMergedBranch,
  diffBase,
  headCommit,
  isLocalBranch,
  isMergedInto,
  mergeTree,
  porcelainStatus,
  pruneWorktrees,
  rangeDiff,
  removeWorktree,
  resolveCommit,
  startMerge,
  worktreeDiff,
  worktreePath,
} from './worktree.js';

/** Rules a task gets when none are given: the git commands it needs to commit its work. */
export const DEFAULT_ALLOWED_TOOLS = presetRules([DEFAULT_PRESET]);

const TICK_MS = 5_000;
/** How often usage that CLIs record themselves (rather than report) is read again. */
const QUOTA_READ_MS = 60_000;
/** How long a profile's model list is reused before its CLI is asked again. */
const MODELS_TTL_MS = 10 * 60_000;
const DEFAULT_REVIEW_ROUNDS = 2;
/** Each role's model field with the effort field that belongs to it. */
const ROLE_MODEL_EFFORT = [
  ['implementerModel', 'implementerEffort'],
  ['reviewerModel', 'reviewerEffort'],
  ['specModel', 'specEffort'],
  ['testerModel', 'testerEffort'],
  ['designerModel', 'designerEffort'],
] as const;

export interface HarnessOptions {
  /** Where runtime setting changes are saved; omitted keeps them in memory (tests). */
  settingsFile?: string | null;
  /** Builds agent adapters from profiles; tests substitute fake CLIs. */
  adapterFactory?: AdapterFactory;
  /** Commands {@link Harness.detectAgents} looks for; tests point them at fake CLIs. */
  detectCommands?: Record<AgentProvider, string>;
}
type PermissionRequestEvent = Extract<AgentEvent, { kind: 'permission_request' }>;

interface PendingPermission {
  request: PermissionRequest;
  /** Whose quota the reply waits for when the user answers while it is used up. */
  provider: AgentProvider;
  resolve: (reply: PermissionReply) => void;
}

/** Answers given while the provider's quota was used up, sent once it is free again. */
interface HeldReplies {
  provider: AgentProvider;
  replies: { pending: PendingPermission; reply: PermissionReply }[];
}

const STARTABLE: TaskStatus[] = ['backlog', 'stopped', 'failed', 'review', 'waiting_quota'];
/**
 * A `base` task in one of these is using the repository folder: it works there, or its
 * work there waits for an answer or a review that another task's commits would mix into.
 */
const HOLDS_FOLDER: TaskStatus[] = [
  'queued',
  'running',
  'awaiting_permission',
  'waiting_quota',
  'awaiting_approval',
  'review',
];
/** A task can be chatted with while nothing else is about to run in its conversation. */
const CHATTABLE: TaskStatus[] = ['stopped', 'failed', 'review', 'done'];

/**
 * Owns task lifecycle and scheduling. Single-threaded: all state changes happen on the
 * event loop, and subscribers receive {@link HarnessEvent}s instead of sharing state.
 */
export class Harness {
  private readonly running = new Map<number, AbortController>();
  /** Merges in progress by task id, so no `base` task starts in the folder they change. */
  private readonly merging = new Map<number, { repo: string; base: string }>();
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  private readonly quotas = new Map<AgentProvider, QuotaInfo>();
  private readonly adapters = new Map<string, AgentAdapter>();
  private quotaReadAt = 0;
  private readonly modelLists = new Map<string, { at: number; models: ModelInfo[] }>();
  private readonly activities = new Map<number, TaskActivity>();
  /** Tool uses each running task waits on the user for, by request id. */
  private readonly permissions = new Map<number, Map<string, PendingPermission>>();
  /** Answered tool uses whose reply waits for quota; the task shows as `queued`. */
  private readonly held = new Map<number, HeldReplies>();
  private timer: NodeJS.Timeout | null = null;
  private readonly workflow: Workflow;
  private readonly settingsFile: string | null;
  private readonly adapterFactory: AdapterFactory;
  private readonly detectCommands: Record<AgentProvider, string>;

  constructor(
    readonly config: HarnessConfig,
    readonly store: Store,
    options: HarnessOptions = {},
  ) {
    this.settingsFile = options.settingsFile ?? null;
    this.adapterFactory = options.adapterFactory ?? createAdapter;
    this.detectCommands = options.detectCommands ?? DEFAULT_COMMANDS;
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

  /**
   * Looks for each provider's CLI under its usual command and reports the ones that run,
   * with the profile already using it, if any. A CLI that is missing or fails is left out.
   */
  async detectAgents(): Promise<DetectedAgent[]> {
    const found = await Promise.all(
      AGENT_PROVIDERS.map(async (provider): Promise<DetectedAgent | null> => {
        const command = this.detectCommands[provider];
        const adapter = this.adapterFactory({ provider, command, model: null });
        try {
          const version = await probe(adapter.command, adapter.versionArgs);
          const profile = Object.entries(this.config.agents).find(
            ([, p]) => p.provider === provider && p.command === command,
          );
          return { provider, command, version, profileId: profile?.[0] ?? null };
        } catch {
          return null; // not installed here: nothing to offer
        }
      }),
    );
    return found.filter((agent) => agent !== null);
  }

  /**
   * Adds an agent profile and saves it to the user config file, so it can be picked for
   * tasks at once. Throws when the id is invalid or taken, the provider is unknown, the
   * command is empty, or the model or effort is not valid; nothing changes then.
   */
  addAgent(input: NewAgentProfile): AgentProfile {
    // Input comes from HTTP as well, so its field types are checked rather than trusted.
    const { id, provider } = input;
    if (typeof id !== 'string' || !isProfileId(id)) {
      throw new Error(`invalid agent profile id: ${JSON.stringify(id)}`);
    }
    if (this.config.agents[id]) throw new Error(`agent profile "${id}" already exists`);
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    const model = typeof input.model === 'string' ? input.model.trim() || null : null;
    if (model !== null && !isModelId(model)) {
      throw new Error(`invalid model id: ${JSON.stringify(model)}`);
    }
    const effort = effortOrNull(input.effort);
    const profile: AgentProfile = { provider, command, model, ...(effort ? { effort } : {}) };
    validate({ ...this.config, agents: { ...this.config.agents, [id]: profile } });
    this.config.agents[id] = profile;
    if (this.settingsFile) saveUserAgent(id, profile, this.settingsFile);
    return profile;
  }

  /**
   * Sets or (with `null`) removes a profile's default reasoning effort and saves it to the
   * user config file; sessions started from then on use it. Throws when the profile is not
   * configured or the effort is not an effort id; nothing changes then.
   */
  setAgentEffort(agentId: string, update: AgentEffortUpdate): AgentProfile {
    const current = this.config.agents[agentId];
    if (!current) throw new Error(`agent profile "${agentId}" is not configured`);
    const effort = effortOrNull(update.effort);
    const profile = withEffort(current, effort);
    this.config.agents[agentId] = profile;
    if (this.settingsFile) saveUserAgentEffort(agentId, effort, profile, this.settingsFile);
    return profile;
  }

  /**
   * The models an agent profile's CLI offers, cached for {@link MODELS_TTL_MS} because
   * listing them may start the CLI. Empty when the CLI can not list them or listing fails;
   * a model id can still be typed then. Throws when the profile is not configured.
   */
  async models(agentId: string): Promise<ModelInfo[]> {
    const adapter = this.adapterFor(agentId);
    const cached = this.modelLists.get(agentId);
    if (cached && cached.at > Date.now() - MODELS_TTL_MS) return cached.models;
    let models: ModelInfo[] = [];
    try {
      models = (await adapter.listModels?.()) ?? [];
    } catch {
      // An older CLI without a model catalog: the picker offers typing an id instead.
    }
    // The board offers an effort only from this list, so a CLI that ignores it offers none.
    if (!adapter.capabilities.effort) {
      models = models.map((m) => ({ ...m, efforts: [], defaultEffort: null }));
    }
    this.modelLists.set(agentId, { at: Date.now(), models });
    return models;
  }

  /** What a running task is doing right now; `null` when it is not running. */
  activity(taskId: number): TaskActivity | null {
    return this.activities.get(taskId) ?? null;
  }

  /** The user's reply to a plan that the planner has not handled yet. */
  pendingPlanFeedback(taskId: number): string | null {
    return this.workflow.pendingPlanFeedback(taskId);
  }

  /** The user's request to change a task's spec, while it waits for the spec author. */
  pendingSpecRevision(taskId: number): SpecRevisionRequest | null {
    return this.workflow.pendingSpecRevision(taskId);
  }

  /** The change to a task's spec that waits for the user to approve or reject it. */
  specChange(taskId: number): SpecChangeProposal | null {
    return this.workflow.specChange(taskId);
  }

  /** Repo-relative path of the task's spec file; `null` until the spec author wrote it. */
  specFile(taskId: number): string | null {
    return this.workflow.specFile(taskId);
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
   * task (or, with `scope: 'global'`, to the settings for every task), so this and later
   * sessions use them without asking. The task goes back to `running` once nothing else is
   * waiting. Throws when the request is not pending or a rule is invalid; nothing is
   * answered then. While the provider's quota is used up the answer is recorded at once,
   * but the agent only gets it once the quota is free again; the task is `queued` until then.
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
    const scope = decision.scope === 'global' ? 'global' : 'task';
    if (rules.length > 0 && scope === 'global') {
      this.updateSettings({ allowedTools: rules.reduce(withTool, this.config.allowedTools) });
    } else if (rules.length > 0) {
      const allowedTools = rules.reduce(withTool, task.permission.allowedTools);
      this.store.updateTask(id, { permission: { ...task.permission, allowedTools } });
    }
    const message = allow ? null : decision.message?.trim() || null;
    this.settlePermission(id, pending, {
      behavior: decision.behavior,
      rules,
      ...(rules.length > 0 ? { scope } : {}),
      message,
      auto: false,
    });
    return this.requireTask(id);
  }

  settings(): EditableSettings {
    const { maxConcurrent, quotaPauseUtilization, defaultContextPolicy, defaultReviewer } =
      this.config;
    const allowedTools = [...this.config.allowedTools];
    const reviewGuidelines = [...this.config.reviewGuidelines];
    const remoteHosts = [...this.config.remoteHosts];
    const androidAppFingerprints = [...this.config.androidAppFingerprints];
    return {
      maxConcurrent,
      quotaPauseUtilization,
      defaultContextPolicy,
      defaultReviewer,
      allowedTools,
      reviewGuidelines,
      remoteHosts,
      androidAppFingerprints,
    };
  }

  /**
   * Applies and saves setting changes. Throws on unknown keys, invalid values or a review
   * guideline file that can not be read, leaving the current settings untouched.
   */
  updateSettings(patch: Partial<EditableSettings>): EditableSettings {
    const unknown = Object.keys(patch).filter(
      (k) => !(EDITABLE_SETTINGS as readonly string[]).includes(k),
    );
    if (unknown.length > 0) throw new Error(`unknown settings: ${unknown.join(', ')}`);
    validate({ ...this.config, ...patch });
    if (patch.reviewGuidelines) readGuidelines(patch.reviewGuidelines);
    Object.assign(this.config, patch);
    if (this.settingsFile) saveUserConfig(patch, this.settingsFile);
    this.tick(); // a higher concurrency limit may let queued tasks start now
    return this.settings();
  }

  /**
   * Starts periodic scheduling. Tasks left `running` or `awaiting_permission` by a previous
   * process that died are re-queued, because their agent process no longer exists.
   * A `base` task among them first gets the end its session never recorded, before any
   * other task can start, so the commits it made before the crash stay its work. A chat cut
   * off by the crash also rebuilds a review or test still waiting, so the chat's changes are
   * not blamed on the reviewer or tester.
   */
  async start(): Promise<void> {
    for (const task of this.store.listTasks()) {
      const interrupted = task.status === 'running' || task.status === 'awaiting_permission';
      if (interrupted) await this.endInterrupted(task);
      // A chat is the user's own conversation, not workflow work to pick up again.
      const chat = this.unansweredChat(task.id);
      if (chat && interrupted) {
        await this.refreshInterruptedChat(task.id);
        this.endChat(task.id, chat.sessionId, chat.message.returnTo, 'stopped');
        continue;
      }
      // A task that waited for permission asks again once its session resumes.
      if (interrupted) this.setStatus(task.id, 'queued');
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  /**
   * Records where a `base` task's session cut off by a crash left HEAD. Without it the end
   * stays where that session started, so its commits would look like other work in the
   * folder. Commits made by hand before the restart count as its work too; there is no way
   * to tell them apart. When git cannot read the folder the task is told and keeps the old
   * end.
   */
  private async endInterrupted(task: Task): Promise<void> {
    if (task.workspace !== 'base' || !task.startCommit) return;
    try {
      await this.endOnBase(task);
    } catch (err) {
      this.notice(
        task.id,
        `could not record where the interrupted session left ${task.repoPath}: ` +
          (err as Error).message,
      );
    }
  }

  /**
   * Rebuilds a review or test still waiting when a chat was cut off by a crash, as
   * {@link runChat} would have when it ended. Without it the check keeps its old baseline
   * and the reviewer or tester is blamed for what the chat changed. When git cannot read
   * the folder the task is told and the check keeps its old scope.
   */
  private async refreshInterruptedChat(taskId: number): Promise<void> {
    const task = this.requireTask(taskId); // after endInterrupted recorded the end
    try {
      await this.workflow.refreshAfterChat(task);
    } catch (err) {
      this.notice(
        task.id,
        `could not update the waiting check after the interrupted chat: ` + (err as Error).message,
      );
    }
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
   * allowed-tools entry is not a tool rule, an agent profile or model id is invalid, or the
   * workspace is unknown.
   */
  async createTask(input: CreateTaskInput): Promise<Task> {
    const workspace = input.workspace ?? 'worktree';
    if (workspace !== 'worktree' && workspace !== 'base') {
      throw new Error(`unknown workspace ${String(workspace)}; use worktree or base`);
    }
    const repoPath = await resolveRepository(input.repo);
    const project = loadProjectConfig(repoPath);
    const contextPolicy = {
      ...this.config.defaultContextPolicy,
      ...project.contextPolicy,
      ...definedOnly({
        size: input.size,
        compactPct: input.compactPct,
        softPct: input.softPct,
        hardPct: input.hardPct,
      }),
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
      implementerEffort: effortOrNull(input.implementerEffort),
      reviewerModel: modelOrNull(input.reviewerModel),
      reviewerEffort: effortOrNull(input.reviewerEffort),
      spec: input.spec ?? null,
      specModel: modelOrNull(input.specModel),
      specEffort: effortOrNull(input.specEffort),
      tester: input.tester ?? null,
      testerModel: modelOrNull(input.testerModel),
      testerEffort: effortOrNull(input.testerEffort),
      designer: input.designer ?? null,
      designerModel: modelOrNull(input.designerModel),
      designerEffort: effortOrNull(input.designerEffort),
    };
    this.checkProfiles(agents);
    const task = this.store.createTask({
      title: input.title ?? firstLine(input.prompt),
      prompt: input.prompt,
      repoPath,
      baseRef: input.baseRef ?? project.baseRef ?? (await currentRef(repoPath)),
      workspace,
      mode,
      verifyCommand: mode === 'loop' || agents.tester ? verifyCommand : null,
      acceptance,
      confirmPlan,
      contextPolicy,
      permission: {
        // A loop session is told to run the verify command, so it must be allowed to.
        allowedTools:
          (mode === 'loop' || agents.tester) && verifyCommand
            ? withTool(allowedTools, `Bash(${verifyCommand})`)
            : allowedTools,
        skipPermissions: input.skipPermissions ?? false,
        autoApprove: input.autoApprove ?? true,
      },
      agents,
    });
    this.emit({ type: 'task', taskId: task.id, status: task.status });
    if (input.queue) return this.queueTask(task.id);
    return task;
  }

  /**
   * Puts a task in line to run. A task in review is sent back to work with the last review's
   * feedback and fresh review rounds. Throws when it is missing, running, queued or done,
   * or it works on the base while another such task holds the same repository folder.
   */
  queueTask(id: number): Task {
    const task = this.requireTask(id);
    if (!STARTABLE.includes(task.status)) {
      throw new Error(`task ${id} is ${task.status} and cannot be queued`);
    }
    if (task.workspace === 'base') this.assertFolderFree(task);
    if (task.status === 'review') {
      this.workflow.sendBack(id);
      this.notice(id, 'sent back to work by you; review rounds start again');
    }
    const queued = this.setStatus(id, 'queued', { resumeAt: null });
    this.tick();
    return queued;
  }

  /**
   * Two agents in one folder would edit the same files and mix their commits into each
   * other's review, so only one `base` task may hold a repository folder at a time. A merge
   * into the branch checked out there moves its files, so none may start during one either.
   */
  private assertFolderFree(task: Task): void {
    const busy = this.folderBusy(task);
    if (busy) throw new Error(busy);
  }

  /** Why the `base` task may not use its repository folder now, or null when it may. */
  private folderBusy(task: Task): string | null {
    const other = this.folderHolder(task.repoPath, task.id);
    if (other) {
      return (
        `task ${other.id} already works directly on ${other.baseRef} in ${task.repoPath} ` +
        `(${other.status}); finish or stop it before starting task ${task.id}`
      );
    }
    const merge = [...this.merging].find(
      ([, m]) => m.repo === task.repoPath && m.base === task.baseRef,
    );
    if (merge) {
      return (
        `task ${merge[0]} is being merged into ${task.baseRef} in ${task.repoPath}; ` +
        `start task ${task.id} again once the merge is done`
      );
    }
    return null;
  }

  /**
   * The `base` task other than `except` using the repository folder, if any. A task whose
   * session is still being wound up holds it too, whatever status the workflow gave it.
   */
  private folderHolder(repo: string, except: number): Task | undefined {
    return this.store
      .listTasks()
      .find(
        (t) =>
          t.id !== except &&
          t.workspace === 'base' &&
          t.repoPath === repo &&
          (this.running.has(t.id) || HOLDS_FOLDER.includes(t.status)),
      );
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
   * Changes who works on a task and with which models and efforts; fields left out stay as
   * they are. A role whose model changes loses its effort unless the update sets one too,
   * since the new model may not offer it. Takes effect from its next session, so models and
   * efforts may change while a session is open, but the agents (and so the provider) may
   * not. Throws when an agent changes while the task runs, a profile is not configured or
   * a model or effort id is invalid; nothing changes then.
   */
  setAgents(id: number, update: AgentsUpdate): Task {
    const task = this.requireTask(id);
    const swapsAgent =
      (update.implementer !== undefined && update.implementer !== task.agents.implementer) ||
      (update.reviewer !== undefined && update.reviewer !== task.agents.reviewer) ||
      (update.spec !== undefined && update.spec !== (task.agents.spec ?? null)) ||
      (update.tester !== undefined && update.tester !== (task.agents.tester ?? null)) ||
      (update.designer !== undefined && update.designer !== (task.agents.designer ?? null));
    if (swapsAgent && (this.running.has(id) || task.status === 'running')) {
      throw new Error(`task ${id} is running; stop it before changing its agents`);
    }
    const agents: TaskAgents = { ...task.agents };
    if (update.implementer !== undefined) agents.implementer = update.implementer;
    if (update.reviewer !== undefined) agents.reviewer = update.reviewer;
    if (update.spec !== undefined) agents.spec = update.spec;
    if (update.tester !== undefined) agents.tester = update.tester;
    if (update.designer !== undefined) agents.designer = update.designer;
    for (const [modelKey, effortKey] of ROLE_MODEL_EFFORT) {
      const model = update[modelKey];
      if (model !== undefined) {
        const next = modelOrNull(model);
        if (next !== (agents[modelKey] ?? null)) agents[effortKey] = null;
        agents[modelKey] = next;
      }
      const effort = update[effortKey];
      if (effort !== undefined) agents[effortKey] = effortOrNull(effort);
    }
    this.checkProfiles(agents);
    const updated = this.store.updateTask(id, { agents });
    this.emit({ type: 'task', taskId: id, status: updated.status });
    return updated;
  }

  /**
   * Turns auto-approve on or off for a task. Takes effect from the next tool the agent asks
   * about, also while it runs.
   */
  setAutoApprove(id: number, on: boolean): Task {
    const task = this.requireTask(id);
    const updated = this.store.updateTask(id, {
      permission: { ...task.permission, autoApprove: on },
    });
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
   * Deletes a task with its history and review evidence, and removes its worktree directory, discarding any
   * uncommitted changes there. The branch is kept, so committed work can still be merged.
   * A `base` task's folder is the repository itself, so nothing on disk is touched.
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
    if (task.workspace === 'worktree' && task.worktreePath) {
      await this.discardWorktree(task.repoPath, task.worktreePath);
    }
    await rm(this.evidenceDir(id), { recursive: true, force: true });
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
    const change = this.workflow.specChange(id);
    if (change) {
      // A reply to a proposed spec change goes to the spec author, who proposes it again.
      this.workflow.requestSpecRevision(id, message, change.onReject);
    } else {
      this.store.appendEvent(id, null, 'plan_feedback', { message: message.trim() });
    }
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
    if (task.status === 'awaiting_approval' && this.workflow.specChange(id)) {
      return this.approveSpecChange(id, criteria);
    }
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

  /**
   * Asks the spec author to propose a change to the spec of a single task that is already
   * being built. The task then waits for the user's approval as it did for the first spec.
   * A running task is asked once its current session ends; a task in review, stopped or
   * failed goes back in line for it. Throws when the task has no spec file yet, is waiting
   * for an approval or done, the message is empty, or it works on the base while another
   * task holds the folder.
   */
  requestSpecRevision(id: number, message: string): Task {
    const task = this.requireTask(id);
    if (task.mode !== 'single' || !this.workflow.specFile(id)) {
      throw new Error(`task ${id} has no spec file to change`);
    }
    if (['backlog', 'awaiting_approval', 'done'].includes(task.status)) {
      throw new Error(`task ${id} is ${task.status}; a spec change needs work under way`);
    }
    const text = optionalText(message, 'message') ?? '';
    const idle = !this.running.has(id) && ['review', 'stopped', 'failed'].includes(task.status);
    if (idle && task.workspace === 'base') this.assertFolderFree(task);
    this.workflow.requestSpecRevision(id, text, task.status);
    if (!idle) {
      this.emit({ type: 'task', taskId: id, status: task.status });
      return this.requireTask(id);
    }
    // The change may need more work, so the reviewer's and tester's rounds count afresh.
    if (task.status === 'review') this.workflow.sendBack(id);
    const queued = this.setStatus(id, 'queued', { resumeAt: null });
    this.tick();
    return queued;
  }

  /**
   * Approves the waiting spec change: its criteria (or `criteria`, e.g. after the user
   * edited them) become the task's, the spec file is rewritten and committed before the next
   * session, and the implementer goes on against them. Throws when no change is waiting or
   * there are no criteria to approve.
   */
  approveSpecChange(id: number, criteria?: string): Task {
    const task = this.requireSpecChange(id);
    const decision = this.workflow.decideSpecChange(task, true, optionalText(criteria, 'criteria'));
    this.store.updateTask(id, { acceptance: decision.criteria });
    this.notice(id, 'spec change approved; revising the spec');
    const queued = this.setStatus(id, 'queued');
    this.tick();
    return queued;
  }

  /**
   * Rejects the waiting spec change: the spec file and criteria stay as they are, and the
   * task goes back to where it was, the implementer's work or review. Throws when no change
   * is waiting.
   */
  rejectSpecChange(id: number): Task {
    const task = this.requireSpecChange(id);
    const { onReject } = this.workflow.specChange(id)!;
    this.workflow.decideSpecChange(task, false);
    this.notice(id, 'spec change rejected; the spec stays as it is');
    const next = this.setStatus(id, onReject);
    if (onReject === 'queued') this.tick();
    return next;
  }

  private requireSpecChange(id: number): Task {
    const task = this.requireTask(id);
    if (task.status !== 'awaiting_approval' || !this.workflow.specChange(id)) {
      throw new Error(`task ${id} has no spec change waiting for a decision`);
    }
    return task;
  }

  /**
   * Writes `message` into the task's latest implementer conversation and runs the agent
   * until it replies, as if typed in that session: it may edit files, its tool rules and
   * permission prompts apply, and nothing moves on in the workflow. The task then returns
   * to the status it had.
   * While the task is busy (running, queued, waiting for quota or approval) the message is
   * kept as pending instead and sent when the current step ends; see {@link pendingChat}.
   * Throws when the message is empty, or the task is idle and there is no conversation to
   * continue, its context is full, or it works on the base while another task holds or a
   * merge changes the same repository folder.
   */
  chat(id: number, message: string): Task {
    const task = this.requireTask(id);
    const text = optionalText(message, 'message')?.trim();
    if (!text) throw new Error('message is empty');
    if (this.running.has(id) || !CHATTABLE.includes(task.status)) {
      this.store.appendEvent(id, null, 'chat_queued', { text } satisfies ChatQueued);
      this.emit({ type: 'task', taskId: id, status: task.status });
      return task;
    }
    if (task.workspace === 'base') this.assertFolderFree(task);
    const target = this.chatTarget(task);
    if (typeof target === 'string') throw new Error(target);
    return this.startChat(task, target, text);
  }

  /**
   * Messages written while the task was busy that have not been sent or cancelled yet,
   * oldest first.
   */
  pendingChat(taskId: number): string[] {
    const after = Math.max(
      this.store.lastEvent(taskId, 'chat_message')?.id ?? 0,
      this.store.lastEvent(taskId, 'chat_queue_cleared')?.id ?? 0,
    );
    return this.store
      .eventsOfKinds(taskId, ['chat_queued'], after)
      .map((e) => (e.data as ChatQueued).text);
  }

  /** Drops the task's pending chat messages unsent. Throws when there are none. */
  cancelChat(id: number): Task {
    const task = this.requireTask(id);
    if (this.pendingChat(id).length === 0) throw new Error(`task ${id} has no pending message`);
    this.clearPendingChat(id, { reason: 'cancelled' });
    return task;
  }

  private clearPendingChat(taskId: number, cleared: ChatQueueCleared): void {
    this.store.appendEvent(taskId, null, 'chat_queue_cleared', cleared);
    this.emit({ type: 'task', taskId, status: this.requireTask(taskId).status });
  }

  /**
   * Sends the pending messages of an idle task as one turn. A task that has stopped drops
   * them when they cannot be sent, since nothing would change that; a queued one keeps them
   * for after its next step, which may start a conversation they fit into. A `base` task
   * whose folder another task holds keeps them until a later tick finds the folder free.
   * Returns true when a reply started.
   */
  private deliverPendingChat(task: Task): boolean {
    const pending = this.pendingChat(task.id);
    if (pending.length === 0) return false;
    if (task.workspace === 'base' && this.folderBusy(task)) return false;
    const target = this.chatTarget(task);
    if (typeof target === 'string') {
      if (CHATTABLE.includes(task.status)) {
        this.clearPendingChat(task.id, { reason: 'undeliverable', detail: target });
        this.notice(task.id, `pending message not sent: ${target}`);
      }
      return false;
    }
    this.startChat(task, target, pending.join('\n\n'));
    return true;
  }

  /** The conversation a chat continues, or why there is none to continue. */
  private chatTarget(task: Task): Session | string {
    const session = this.store.listSessions(task.id).findLast(
      (s) =>
        s.role === 'implementer' &&
        s.agentSessionId !== null &&
        // Codex reports its thread id but no context size; zero does not mean no conversation.
        (s.contextTokens > 0 || this.config.agents[s.agentId]?.provider === 'codex'),
    );
    if (!session) return `task ${task.id} has no conversation to continue yet`;
    if (!task.worktreePath) return `task ${task.id} was merged; its worktree is gone`;
    const window = session.contextWindow ?? this.workflow.contextWindow(session.agentId);
    if (
      contextPct(session.contextTokens, window) >= resolveThresholds(task.contextPolicy).hardPct
    ) {
      // hb open refuses a `base` task, so it is not suggested for one.
      const hint = task.workspace === 'base' ? '' : `; continue it with hb open ${task.id}`;
      return `the conversation of task ${task.id} is full${hint}`;
    }
    return session;
  }

  private startChat(task: Task, session: Session, text: string): Task {
    const chat: ChatMessage = { text, returnTo: task.status };
    this.store.appendEvent(task.id, session.id, 'chat_message', chat);
    const controller = new AbortController();
    // Registered before returning, so the scheduler and other calls see the task as busy.
    this.running.set(task.id, controller);
    this.setActivity(task.id, { phase: 'chatting', agentId: session.agentId });
    const running = this.setStatus(task.id, 'running');
    void this.runChat(task, session, text, controller);
    return running;
  }

  private async runChat(
    task: Task,
    session: Session,
    text: string,
    controller: AbortController,
  ): Promise<void> {
    let reason: ChatEnd['reason'] = 'error';
    try {
      const ready = task.workspace === 'base' ? await this.startOnBase(task) : task;
      const plan: SessionPlan = {
        role: 'implementer',
        agentId: session.agentId,
        access: 'edit',
        resume: session,
        prompt: text,
      };
      const adapter = this.adapterFor(session.agentId);
      await adapter.ensureReady?.();
      const outcome = await this.runOne(ready, session.id, plan, adapter, controller.signal, true)
        // Before the task returns to its status and may let go of the folder.
        .finally(async () => {
          await this.endOnBase(ready);
          await this.workflow.refreshAfterChat(ready);
        });
      reason = outcome.reason;
    } catch (err) {
      this.notice(task.id, `chat failed: ${(err as Error).message}`);
    } finally {
      this.dropPermissions(task.id);
      this.running.delete(task.id);
      this.activities.delete(task.id);
      const chat = this.unansweredChat(task.id);
      if (chat) this.endChat(task.id, session.id, chat.message.returnTo, reason);
      if (this.timer) this.tick();
    }
  }

  /** The latest chat message when its reply has not ended yet. */
  private unansweredChat(
    taskId: number,
  ): { sessionId: string | null; message: ChatMessage } | null {
    const message = this.store.lastEvent(taskId, 'chat_message');
    const end = this.store.lastEvent(taskId, 'chat_end');
    if (!message || (end && end.id > message.id)) return null;
    return { sessionId: message.sessionId, message: message.data as ChatMessage };
  }

  private endChat(
    taskId: number,
    sessionId: string | null,
    returnTo: TaskStatus,
    reason: ChatEnd['reason'],
  ): void {
    this.store.appendEvent(taskId, sessionId, 'chat_end', { reason } satisfies ChatEnd);
    if (!this.store.getTask(taskId)) return;
    this.setStatus(taskId, returnTo);
    // A spec change asked for during the chat would otherwise wait in review forever.
    this.workflow.reviseAfterStep(taskId);
  }

  /**
   * Merges a reviewed task's branch into its base branch with a merge commit (`chore: merge task
   * #N`, the title in the body), then marks the task done, removes its worktree and deletes the merged
   * branch. The merge is made without a worktree; the user's own checkout only changes when
   * it has the base branch checked out, and is then fast-forwarded, which git refuses when
   * local changes would be overwritten.
   * When the base has conflicting changes, nothing on the base changes: the base is merged
   * into the task's worktree instead, its agent is queued to resolve the conflicts and
   * commit, and the task comes back for review (and another merge) afterwards.
   * Throws when the task is not in review, has uncommitted changes or nothing to merge, its
   * base is not a local branch, git refuses, or a `base` task works on that base in the
   * repository folder (the merge would move its files underneath its agent). A `base` task
   * has nothing to merge: its commits are on the base already, and {@link completeTask}
   * finishes it.
   */
  async mergeTask(id: number): Promise<MergeResult> {
    const task = this.requireTask(id);
    if (task.status !== 'review') throw new Error(`task ${id} is ${task.status}, not review`);
    if (task.workspace === 'base') {
      throw new Error(
        `task ${id} works directly on ${task.baseRef}, so there is nothing to merge; mark it done`,
      );
    }
    const { repoPath: repo, baseRef: base, branch, worktreePath: dir } = task;
    if (!branch || !dir) throw new Error(`task ${id} has no branch to merge`);
    const holder = this.folderHolder(repo, id);
    if (holder?.baseRef === base) {
      throw new Error(
        `task ${holder.id} works directly on ${base} in ${repo} (${holder.status}); ` +
          `finish or stop it before merging task ${id}`,
      );
    }
    // Registered before the first await, so no `base` task can start while git works.
    this.merging.set(id, { repo, base });
    try {
      return await this.mergeInto(task, repo, base, branch, dir);
    } finally {
      this.merging.delete(id);
    }
  }

  private async mergeInto(
    task: Task,
    repo: string,
    base: string,
    branch: string,
    dir: string,
  ): Promise<MergeResult> {
    const id = task.id;
    if ((await porcelainStatus(dir)) !== '') {
      throw new Error(
        `task ${id} has uncommitted changes in its worktree; commit or discard them first`,
      );
    }
    if (!(await isLocalBranch(repo, base))) {
      throw new Error(`the base ${base} is not a local branch, so there is nothing to merge into`);
    }
    if (await isMergedInto(repo, branch, base)) {
      throw new Error(`${base} already has every commit of ${branch}`);
    }
    const merged = await mergeTree(repo, base, branch);
    if ('conflicts' in merged) return this.resolveConflicts(task, dir, merged.conflicts);

    const [from, head] = await Promise.all([
      resolveCommit(repo, base),
      resolveCommit(repo, branch),
    ]);
    // The subject stays fixed and English; the title is free text, so it goes in the body.
    const message = `chore: merge task #${id}\n\n${task.title}\n\nBranch ${branch}`;
    const commit = await commitTree(repo, merged.tree, [from, head], message);
    await advanceBranch(repo, base, from, commit);
    const record: MergeRecord = { base, branch, commit };
    this.store.appendEvent(id, null, 'merged', record);
    this.notice(id, `merged ${branch} into ${base} (${commit.slice(0, 8)})`);
    // The branch is in the base now; only the scratch copy and the branch name go.
    await this.discardWorktree(repo, dir);
    await deleteMergedBranch(repo, branch, base);
    this.store.updateTask(id, { worktreePath: null });
    this.setStatus(id, 'done');
    return { status: 'merged', ...record };
  }

  private async resolveConflicts(task: Task, dir: string, files: string[]): Promise<MergeResult> {
    const conflict: MergeConflict = { base: task.baseRef, files };
    // Started here, not by the agent, so a task without `git merge` in its rules can resolve;
    // awaited before queueing, so the agent finds the conflict markers.
    await startMerge(dir, task.baseRef);
    this.store.appendEvent(task.id, null, 'merge_conflict', conflict);
    this.notice(
      task.id,
      `merging ${task.baseRef} conflicts in ${files.length} files; agent resolves`,
    );
    this.setStatus(task.id, 'queued');
    this.tick();
    return { status: 'conflicts', ...conflict };
  }

  /** Latest merge of the task's branch into its base, if it was merged. */
  lastMerge(taskId: number): MergeRecord | null {
    return (this.store.lastEvent(taskId, 'merged')?.data as MergeRecord | undefined) ?? null;
  }

  /** Marks a reviewed task as done. */
  completeTask(id: number): Task {
    const task = this.requireTask(id);
    if (task.status !== 'review') throw new Error(`task ${id} is ${task.status}, not review`);
    return this.setStatus(id, 'done');
  }

  /**
   * Everything the task changed. A `base` task's earlier stretches come first, one patch
   * each; untracked files are only shown while it holds the folder, since after that they
   * may be anyone's.
   */
  async diff(id: number): Promise<WorktreeDiff> {
    const task = this.requireTask(id);
    if (!task.worktreePath) return { diff: '', untracked: [] };
    if (task.workspace === 'worktree') return worktreeDiff(task.worktreePath, diffBase(task));
    const { closed, liveFrom } = this.baseHistory(task);
    const patches = await Promise.all(closed.map((span) => rangeDiff(task.repoPath, span)));
    const live = liveFrom
      ? await worktreeDiff(task.repoPath, liveFrom)
      : { diff: '', untracked: [] };
    return { diff: [...patches, live.diff].join(''), untracked: live.untracked };
  }

  /**
   * A `base` task's stretches of work in the repository folder. While it holds the folder its
   * current stretch runs up to the working tree (`liveFrom`); once it lets go, the stretch
   * ends where its last session left HEAD, so later work in the folder is not counted as its.
   */
  private baseHistory(task: Task): { closed: CommitSpan[]; liveFrom: string | null } {
    const holds = this.running.has(task.id) || HOLDS_FOLDER.includes(task.status);
    if (holds || task.endCommit === null) {
      return { closed: task.priorSpans, liveFrom: task.startCommit };
    }
    const last = { from: task.startCommit!, to: task.endCommit };
    return { closed: [...task.priorSpans, last], liveFrom: null };
  }

  /** The task's notes file: what each role reported, kept even after the worktree is gone. */
  notes(id: number): TaskNotes {
    return { markdown: this.workflow.renderedNotes(this.requireTask(id)) };
  }

  /**
   * Commits on the task's branch since its base, or a `base` task's commits since it
   * started, newest first; none before it has a worktree.
   */
  async commits(id: number): Promise<CommitInfo[]> {
    const task = this.requireTask(id);
    if (!task.worktreePath) return [];
    if (task.workspace === 'worktree') return commitLog(task.worktreePath, diffBase(task));
    const { closed, liveFrom } = this.baseHistory(task);
    const logs = await Promise.all([
      ...closed.map((span) => commitRange(task.repoPath, span)),
      ...(liveFrom ? [commitLog(task.repoPath, liveFrom)] : []),
    ]);
    return logs.reverse().flat();
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
    if (now - this.quotaReadAt >= QUOTA_READ_MS) void this.readQuotas(now);
    this.releaseHeld(now);
    for (const task of dueForRetry(this.store.listTasks(), now)) {
      this.setStatus(task.id, 'queued', { resumeAt: null });
    }
    // Like a message written to an idle task, these do not wait for a free slot.
    for (const task of this.store.listTasks()) {
      if (CHATTABLE.includes(task.status) && !this.running.has(task.id)) {
        this.deliverPendingChat(task);
      }
    }
    // A task waits only when the provider of its next session is short of quota.
    const ready = this.store
      .listTasks()
      .filter((t) => t.status !== 'queued' || !this.nextSessionBlocked(t, now));
    const next = startable(ready, this.running, this.config.maxConcurrent);
    // Pending messages take the task's turn; its workflow goes on once the reply ends.
    for (const task of next) {
      if (!this.deliverPendingChat(task)) void this.runTask(task);
    }
  }

  private nextSessionBlocked(task: Task, now: number): boolean {
    const profile = this.config.agents[this.workflow.nextAgentId(task)];
    return profile !== undefined && this.quotaBlocked(profile.provider, now);
  }

  private quotaBlocked(provider: AgentProvider, now: number): boolean {
    const quota = this.quotas.get(provider) ?? null;
    return quotaBlocks(quota, now, this.config.quotaPauseUtilization);
  }

  /**
   * Reads usage from the records of CLIs that keep it there instead of reporting it while
   * they run (Codex), so it shows and pauses sessions like Claude Code's. Usage the user ran
   * up outside Harnessboard counts too.
   */
  private async readQuotas(now: number): Promise<void> {
    this.quotaReadAt = now;
    for (const provider of AGENT_PROVIDERS) {
      const agentId = this.profilesOf(provider)[0];
      const adapter = agentId ? this.adapterFor(agentId) : null;
      if (!adapter?.readQuota) continue;
      try {
        const quota = await adapter.readQuota();
        if (!quota) continue;
        this.quotas.set(provider, quota);
        this.emit({ type: 'quota', provider, quota });
      } catch {
        // Its records could not be read this time; the last reading stays until the next.
      }
    }
  }

  /** Where the git output for a reviewer without `readOnlyGit` is written (`reviewEvidence`). */
  private evidenceDir(taskId: number): string {
    return path.join(this.config.dataDir, 'evidence', String(taskId));
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
      try {
        await this.workflow.reviseSpecFile(ready);
        let plan = this.workflow.plan(ready);
        await this.workflow.syncNotes(ready);
        const adapter = this.adapterFor(plan.agentId);
        // Before any session is recorded, so a sandbox that can not run fails the task cleanly.
        await adapter.ensureReady?.();
        if (plan.role === 'reviewer' && !adapter.capabilities.readOnlyGit) {
          // The files stay until the next review, so a resumed reviewer can still read them.
          const evidenceDir = this.evidenceDir(task.id);
          if (plan.review) {
            const evidence = await reviewEvidence(ready.worktreePath!, plan.review, evidenceDir);
            plan = { ...plan, prompt: `${plan.prompt}\n\n${evidence}` };
          }
          const notes = this.workflow.renderedNotes(ready);
          if (notes !== null) {
            const copy = copyNotes(evidenceDir, notes);
            plan = { ...plan, prompt: `${plan.prompt}\n\n${copy}` };
          }
          if (existsSync(evidenceDir)) plan = { ...plan, readableDirs: [evidenceDir] };
        }
        const sessionId = plan.resume?.id ?? randomUUID();
        if (!plan.resume) {
          // CLIs that assign their own ids report them in `init`; see runOne.
          const agentSessionId = adapter.capabilities.sessionIds === 'harness' ? sessionId : null;
          this.store.startSession(sessionId, task.id, plan.role, plan.agentId, agentSessionId);
        }
        const blocked = this.store.lastEvent(task.id, 'commit_check')?.data as
          { ok: boolean; role: string; since: string } | undefined;
        plan = {
          ...plan,
          commitBase:
            blocked && !blocked.ok && blocked.role === plan.role
              ? blocked.since
              : await headCommit(ready.worktreePath!),
        };
        this.workflow.started(task.id, sessionId, plan);
        this.setActivity(task.id, this.workflow.phaseOf(ready, plan));
        this.setStatus(task.id, 'running');
        const outcome = await this.runOne(ready, sessionId, plan, adapter, controller.signal);
        this.store.endSession(sessionId, outcome.reason);
        await this.workflow.finish(ready, plan, outcome, controller.signal);
      } finally {
        // Also when a step before the session failed after the harness committed (a revised
        // spec): those commits are the task's work. After the workflow's own commits, and
        // while `running` still holds the folder, so no other task's commits can come first.
        await this.endOnBase(ready);
      }
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
    // Checked before every session: the user may have switched branches since the last one.
    if (task.workspace === 'base') return this.startOnBase(task);
    if (task.worktreePath) return task;
    const branch = branchName(task.id, task.title);
    const dir = worktreePath(this.config.dataDir, task.repoPath, task.id);
    await addWorktree(task.repoPath, dir, branch, task.baseRef);
    return this.store.updateTask(task.id, { branch, worktreePath: dir });
  }

  /**
   * A `base` task works in the repository folder itself, so its commits land on the base
   * branch, which must be checked out there. The commit it starts at is kept, since without
   * a branch of its own that is the only way to tell its work from what came before.
   * When HEAD moved after its last session (another task or the user committed while it let
   * go of the folder), that stretch is closed and a new one starts here, so those commits
   * never count as its work; a review or test waiting to run is rebuilt to leave them out
   * too. Uncommitted changes already in the folder count as its work.
   * Throws when the base is not checked out there.
   */
  private async startOnBase(task: Task): Promise<Task> {
    await this.assertOnBase(task);
    const head = await headCommit(task.repoPath);
    if (!task.startCommit) {
      return this.store.updateTask(task.id, {
        worktreePath: task.repoPath,
        startCommit: head,
        endCommit: head,
      });
    }
    // No end: a task from before end commits were kept; its history stays as it was.
    if (task.endCommit === null || task.endCommit === head) return task;
    const resumed = this.store.updateTask(task.id, {
      priorSpans: [...task.priorSpans, { from: task.startCommit, to: task.endCommit }],
      startCommit: head,
      endCommit: head,
    });
    await this.workflow.refreshPending(resumed);
    return resumed;
  }

  /**
   * Records where a `base` task's session left HEAD: once the task lets go of the folder,
   * its history ends there. Throws when git cannot read HEAD.
   */
  private async endOnBase(task: Task): Promise<void> {
    if (task.workspace !== 'base') return;
    this.store.updateTask(task.id, { endCommit: await headCommit(task.repoPath) });
  }

  /**
   * Throws unless the repository folder has the task's base branch checked out, so a `base`
   * task's agent never edits and commits on whatever branch the user switched to.
   */
  private async assertOnBase(task: Task): Promise<void> {
    const repo = task.repoPath;
    if (!(await isLocalBranch(repo, task.baseRef)) || (await currentRef(repo)) !== task.baseRef) {
      throw new Error(
        `task ${task.id} works directly on ${task.baseRef}, but ${repo} does not have that ` +
          `branch checked out; check it out there and start the task again`,
      );
    }
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

  private async runOne(
    task: Task,
    sessionId: string,
    plan: SessionPlan,
    adapter: AgentAdapter,
    signal: AbortSignal,
    chat = false,
  ): Promise<SessionOutcome> {
    // A read-only session has nothing to commit or hand off, and a chat is the user's own
    // turn: neither wraps up.
    const wrapUp = !chat && plan.access === 'edit';
    const window = this.workflow.contextWindow(plan.agentId);
    const provider = adapter.provider;
    // A resumed turn may report no usage (e.g. `/compact`), so start from what is known.
    let tokens = plan.resume?.contextTokens ?? 0;
    const started = Date.now();
    const outcome = await runSession({
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
        model: roleModel(task.agents, plan.role) ?? this.config.agents[plan.agentId]!.model,
        effort: sessionEffort(task.agents, plan.role, this.config.agents[plan.agentId]!),
        access: plan.access,
        // A read-only session may run the task's own check, but nothing that edits.
        allowedTools:
          plan.access === 'readOnly'
            ? task.verifyCommand && plan.role !== 'reviewer'
              ? [`Bash(${task.verifyCommand})`]
              : []
            : [...new Set([...task.permission.allowedTools, ...this.config.allowedTools])],
        skipPermissions: task.permission.skipPermissions,
        // Read-only sessions must not change anything, so they are never offered more tools.
        askPermission: plan.access === 'edit' && adapter.capabilities.permissionPrompts,
        readableDirs: plan.readableDirs ?? [],
      },
      thresholds: resolveThresholds(task.contextPolicy),
      wrapUp,
      // Every role: compacted only once its turn has ended, never in the middle of work.
      compact: true,
      contextWindow: window,
      signal,
      onEvent: (event) => {
        if (event.kind === 'init' && event.sessionId) {
          this.store.setAgentSessionId(sessionId, event.sessionId);
        }
        if (event.kind === 'context' || event.kind === 'compact') {
          tokens = event.kind === 'context' ? event.tokens : event.postTokens;
          this.store.updateSessionContext(sessionId, tokens, null);
        }
        // Only a window the agent reported is stored; the fallback is a guess.
        if (event.kind === 'result' && event.contextWindow) {
          this.store.updateSessionContext(sessionId, tokens, event.contextWindow);
        }
        this.recordAgentEvent(task.id, sessionId, provider, event);
      },
      onPermissionRequest: (event) => this.askPermission(task.id, sessionId, provider, event),
      onNotice: (message) => this.notice(task.id, message, sessionId),
      onStderr: (line) => this.store.appendEvent(task.id, sessionId, 'stderr', { line }),
    });
    const record: UsageRecord = {
      role: plan.role,
      agentId: plan.agentId,
      durationMs: Date.now() - started,
      usage: outcome.usage,
      cumulative: provider !== 'gemini',
    };
    this.store.appendEvent(task.id, sessionId, 'usage', record);
    return outcome;
  }

  /**
   * Allows a tool use the task's or the global rules already cover (they may have been
   * added after the CLI started), or that an auto-approving task (the default) may use because
   * it is not dangerous; otherwise records it and waits for the user.
   */
  private askPermission(
    taskId: number,
    sessionId: string,
    provider: AgentProvider,
    event: PermissionRequestEvent,
  ): Promise<PermissionReply> {
    const { requestId, toolName, summary, suggestedRules } = event;
    const task = this.requireTask(taskId);
    const auto = task.permission.autoApprove === true;
    const risk = auto
      ? typeof event.input.approvalRisk === 'string'
        ? event.input.approvalRisk
        : riskOf(toolName, event.input, task.worktreePath!)
      : null;
    const request: PermissionRequest = {
      requestId,
      sessionId,
      toolName,
      summary,
      // A dangerous command is answered once; it must not become a standing rule.
      suggestedRules: risk === null ? suggestedRules : [],
      risk,
      ts: Date.now(),
    };
    const allowed = [...task.permission.allowedTools, ...this.config.allowedTools];
    const covered =
      provider === 'codex' && event.input.rpcMethod === 'item/commandExecution/requestApproval'
        ? typeof event.input.approvalRisk !== 'string' &&
          matchingCodexRules(String(event.input.command ?? ''), allowed).length > 0
        : suggestedRules.length > 0 && suggestedRules.every((rule) => allowed.includes(rule));
    if (covered || (auto && risk === null)) {
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
      waiting.set(requestId, { request, provider, resolve });
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
    const reply: PermissionReply =
      outcome.behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', ...(outcome.message ? { message: outcome.message } : {}) };
    // Either answer lets the agent go on, so neither is sent past the quota limit.
    if (this.held.has(taskId) || this.quotaBlocked(pending.provider, Date.now())) {
      const held = this.held.get(taskId) ?? { provider: pending.provider, replies: [] };
      held.replies.push({ pending, reply });
      this.held.set(taskId, held);
    } else {
      pending.resolve(reply);
    }
    if (waiting?.size === 0 && this.running.has(taskId)) {
      this.setStatus(taskId, this.held.has(taskId) ? 'queued' : 'running');
    }
  }

  /** Sends held answers whose provider has quota again; the agents then go on. */
  private releaseHeld(now: number): void {
    for (const [taskId, held] of this.held) {
      if (this.quotaBlocked(held.provider, now)) continue;
      this.held.delete(taskId);
      for (const { pending, reply } of held.replies) pending.resolve(reply);
      if (!this.permissions.get(taskId)?.size) this.setStatus(taskId, 'running');
    }
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
    const held = this.held.get(taskId)?.replies.map((r) => r.pending) ?? [];
    this.held.delete(taskId);
    const waiting = this.permissions.get(taskId);
    this.permissions.delete(taskId);
    for (const pending of [...held, ...(waiting?.values() ?? [])]) {
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
    for (const id of [
      agents.implementer,
      agents.reviewer,
      agents.spec ?? null,
      agents.tester ?? null,
      agents.designer ?? null,
    ]) {
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

/** A trimmed effort level, or `null` for empty; throws on anything that is not one. */
function effortOrNull(effort: string | null | undefined): string | null {
  const trimmed = effort?.trim();
  if (!trimmed) return null;
  if (!isEffortId(trimmed)) {
    throw new Error(`"${trimmed}" is not a reasoning effort; use e.g. low, medium or high`);
  }
  return trimmed;
}

/**
 * The effort a session of `role` runs with: the task's choice for the role, else the
 * profile's default effort, else `null` for the CLI's default.
 */
function sessionEffort(agents: TaskAgents, role: AgentRole, profile: AgentProfile): string | null {
  return roleEffort(agents, role) ?? profile.effort ?? null;
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
