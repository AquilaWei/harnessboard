// SPDX-License-Identifier: Apache-2.0
import spawn from 'cross-spawn';
import { Argument, Command, InvalidArgumentError, Option } from 'commander';
import { createAdapter, loadConfig, userConfigFile } from '@harnessboard/core';
import type { HarnessConfig } from '@harnessboard/core';
import {
  APP_NAME,
  DEFAULT_PRESET,
  PERMISSION_PRESETS,
  definedOnly,
  formatCost,
  formatDuration,
  presetRules,
} from '@harnessboard/shared';
import type {
  PermissionRequest,
  PlanQuestion,
  TaskSize,
  TaskUsage,
  TaskView,
} from '@harnessboard/shared';
import { ApiClient, ServerUnavailableError } from './client.js';
import { createEventFormatter, formatFeature, formatTaskRow, formatTokens } from './format.js';
import { t } from './i18n.js';
import { startServer } from './serve.js';
import pkg from '../package.json' with { type: 'json' };

const FOLLOW_INTERVAL_MS = 500;

const program = new Command(APP_NAME)
  .description('Run and manage Claude Code tasks in isolated git worktrees')
  .version(pkg.version)
  .option('--port <port>', 'server port', parseInteger);

function config(): HarnessConfig {
  const port = program.opts<{ port?: number }>().port;
  return loadConfig(port ? { overrides: { port } } : {});
}

function client(): ApiClient {
  return new ApiClient(`http://127.0.0.1:${config().port}`);
}

program
  .command('serve')
  .description('start the scheduler and the local API')
  .action(async () => {
    const cfg = config();
    const server = await startServer(cfg);
    for (const agent of server.agents) {
      const vars = { id: agent.id, command: agent.profile.command, file: userConfigFile() };
      if (agent.ok) console.log(t('agentFound', { ...vars, version: agent.version ?? '' }));
      else console.warn(t('agentMissing', { ...vars, error: agent.error ?? '' }));
    }
    console.log(t('serverStarted', { url: server.url }));
    const shutdown = () => void server.close().then(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

/** Options shared by `add` and `loop`. */
function withTaskOptions(command: Command): Command {
  return command
    .option('-C, --repo <dir>', 'repository to work in', process.cwd())
    .option('--title <title>', 'short title (defaults to the first line of the prompt)')
    .option('--criteria <text>', 'acceptance criteria: what must hold for the work to be done')
    .option('--base <ref>', 'git ref to branch from (defaults to the current branch)')
    .addOption(
      new Option('--size <size>', 'task size; sets the soft context threshold').choices([
        'small',
        'medium',
        'large',
      ]),
    )
    .option(
      '--compact <pct>',
      'compact the conversation at this context % (0: never)',
      parseInteger,
    )
    .option('--soft <pct>', 'soft context threshold in percent', parseInteger)
    .option('--hard <pct>', 'hard context threshold in percent', parseInteger)
    .option(
      '--preset <ids>',
      `permission presets, comma-separated: ${PERMISSION_PRESETS.map((p) => p.id).join(', ')} or none (default ${DEFAULT_PRESET})`,
      parsePresets,
    )
    .option('--allow <rules...>', 'more tool rules the agent may use without asking')
    .option('--skip-permissions', 'let the agent run anything (only in a sandbox)')
    .option(
      '--no-auto-approve',
      'ask before every tool the rules do not allow, instead of only dangerous ones',
    )
    .option('--model <model>', 'model for the implementer, e.g. opus, sonnet, haiku')
    .option(
      '--spec <agent>',
      'agent profile that writes the acceptance criteria (default: implementer)',
    )
    .option('--spec-model <model>', 'model for the spec author')
    .option('--reviewer <agent>', 'agent profile that reviews each finished step, or "none"')
    .option('--reviewer-model <model>', 'model for the reviewer')
    .option('--no-queue', 'leave the task in the backlog');
}

async function createTask(prompt: string, o: AddOptions, loop: LoopInput = {}): Promise<void> {
  const task = await client().createTask(
    definedOnly({
      prompt,
      ...loop,
      acceptance: o.criteria,
      repo: o.repo,
      title: o.title,
      baseRef: o.base,
      size: o.size,
      compactPct: o.compact,
      softPct: o.soft,
      hardPct: o.hard,
      allowedTools: allowedTools(o.preset, o.allow),
      skipPermissions: o.skipPermissions,
      autoApprove: o.autoApprove,
      spec: o.spec,
      specModel: o.specModel,
      reviewer: o.reviewer === 'none' ? null : o.reviewer,
      implementerModel: o.model,
      reviewerModel: o.reviewerModel,
      queue: o.queue,
    }),
  );
  console.log(t('taskCreated', { id: task.id, status: task.status }));
}

withTaskOptions(
  program
    .command('add')
    .description(
      'create a task and queue it; without --criteria the agent first proposes acceptance criteria',
    )
    .argument('<prompt...>', 'what the agent should do')
    .option('--no-discuss', 'without --criteria, start right away instead of agreeing on them'),
).action((words: string[], o: AddOptions & { discuss: boolean }) =>
  createTask(words.join(' '), o, { confirmPlan: o.discuss }),
);

withTaskOptions(
  program
    .command('loop')
    .description('plan a goal as a feature list, then build and verify one feature per session')
    .argument('<goal...>', 'what the finished project should do')
    .option(
      '--verify <command>',
      'command the harness runs to check each feature (optional: can be set at approval)',
    )
    .option('--no-confirm-plan', 'start building right after planning (needs --verify)'),
).action((words: string[], o: AddOptions & { verify?: string; confirmPlan: boolean }) =>
  createTask(
    words.join(' '),
    o,
    definedOnly({ mode: 'loop' as const, verifyCommand: o.verify, confirmPlan: o.confirmPlan }),
  ),
);

program
  .command('plan')
  .description("show a task's proposed plan or acceptance criteria, with the agent's questions")
  .argument('<id>', 'task id', parseInteger)
  .action(async (id: number) => {
    const task = await client().getTask(id);
    if (task.mode === 'single') {
      if (task.criteria) console.log(`${task.criteria.reply}\n\n${t('criteriaNext', { id })}`);
      else if (task.acceptance) console.log(task.acceptance);
      else console.log(t('noCriteria', { id }));
      return;
    }
    const plan = await client().plan(id);
    if (plan.reply) console.log(`${plan.reply}\n`);
    if (plan.error) console.log(`✗ ${plan.error}`);
    for (const feature of plan.features ?? []) {
      console.log(formatFeature(feature));
      for (const step of feature.steps ?? []) console.log(`        - ${step}`);
    }
    for (const q of plan.questions) printQuestion(q);
    if (plan.suggestedVerify) console.log(t('suggestedVerify', { command: plan.suggestedVerify }));
    if (!plan.approved) console.log(t('planNext', { id }));
  });

program
  .command('feedback')
  .description('reply to a proposed plan or acceptance criteria; the agent revises them')
  .argument('<id>', 'task id', parseInteger)
  .argument('<message...>', 'your feedback')
  .action(async (id: number, words: string[]) => {
    const task = await client().planFeedback(id, words.join(' '));
    console.log(t('taskStatus', { id, status: task.status }));
  });

program
  .command('approve')
  .description('approve a proposed plan or acceptance criteria and start building')
  .argument('<id>', 'task id', parseInteger)
  .option('--verify <command>', 'loop tasks: verify command (required unless the task has one)')
  .option('--criteria <text>', 'single tasks: approve these criteria instead of the proposed ones')
  .action(async (id: number, o: { verify?: string; criteria?: string }) => {
    const api = client();
    const { mode } = await api.getTask(id);
    const task =
      mode === 'single'
        ? await api.approveCriteria(id, o.criteria)
        : await api.approvePlan(id, o.verify);
    console.log(t('taskStatus', { id, status: task.status }));
  });

program
  .command('agents')
  .description('list agent profiles and whether their CLIs run')
  .action(async () => {
    for (const a of await client().agents()) {
      const state = a.ok ? `✓ ${a.version ?? ''}` : `✗ ${a.error ?? ''}`;
      const model = a.profile.model ?? t('defaultModel');
      console.log(
        `${a.id.padEnd(12)} ${a.profile.provider.padEnd(12)} ${model.padEnd(14)} ${state}`,
      );
    }
  });

program
  .command('ls')
  .description('list tasks')
  .action(async () => {
    const tasks = await client().listTasks();
    if (tasks.length === 0) return console.log(t('noTasks'));
    for (const task of tasks) console.log(formatTaskRow(task));
  });

program
  .command('show')
  .description('show a task and its sessions')
  .argument('<id>', 'task id', parseInteger)
  .action(async (id: number) => {
    const task = await client().getTask(id);
    console.log(formatTaskRow(task));
    console.log(`  repo:     ${task.repoPath} (${task.baseRef})`);
    console.log(`  worktree: ${task.worktreePath ?? '-'} ${task.branch ?? ''}`);
    if (task.acceptance) {
      console.log(`  ${t('criteriaHeading')}`);
      for (const line of task.acceptance.split('\n')) console.log(`    ${line}`);
    }
    if (task.criteria) console.log(`  ${t('criteriaNext', { id })}`);
    if (task.context) {
      const c = task.context;
      const line = t('contextLine', {
        pct: c.pct,
        window: formatTokens(c.window),
        compact: c.compactPct ?? '-',
        soft: c.softPct,
        hard: c.hardPct,
      });
      console.log(`  ${line}`);
    }
    if (task.loop) {
      const v = task.loop.lastVerify;
      const verify = v ? t(v.ok ? 'verifyPassed' : 'verifyFailed', { command: v.command }) : '';
      console.log(
        `  ${t('loopLine', { verified: task.loop.verified, total: task.loop.total })} ${verify}`,
      );
    }
    for (const feature of task.features ?? []) console.log(formatFeature(feature));
    for (const r of task.permissionRequests) {
      const rules = r.suggestedRules.length > 0 ? `  [${r.suggestedRules.join(', ')}]` : '';
      console.log(
        `  ${t('permissionWaiting', { tool: r.toolName, summary: r.summary, request: r.requestId })}${rules}${r.risk ? `  (${r.risk})` : ''}`,
      );
    }
    console.log(`  ${usageLine(task.usage)}`);
    for (const s of task.sessions) {
      const who = `${s.role}/${s.agentId}`.padEnd(22);
      console.log(
        `  session ${s.id}  ${who} ${s.endReason ?? 'active'}  ${formatTokens(s.contextTokens)}`,
      );
    }
    const review = task.lastReview;
    if (review) {
      const verdict = review.verdict ?? t('noVerdict');
      console.log(`  ${t('reviewLine', { agent: review.agentId, round: review.round, verdict })}`);
      if (review.findings) console.log(indent(review.findings));
    }
  });

function usageLine(usage: TaskUsage): string {
  const time = t('usageTime', {
    agent: usage.runs > 0 ? formatDuration(usage.agentMs) : '-',
    elapsed: usage.elapsedMs === null ? '-' : formatDuration(usage.elapsedMs),
    runs: usage.runs,
  });
  const u = usage.tokens;
  if (!u) return `${t('usageNone')} · ${time}`;
  const tokens = t('usageTokens', {
    total: formatTokens(u.input + u.output + u.cacheRead + u.cacheWrite),
    input: formatTokens(u.input),
    output: formatTokens(u.output),
    cacheRead: formatTokens(u.cacheRead),
    cacheWrite: formatTokens(u.cacheWrite),
  });
  const cost =
    usage.costUsd === null ? '' : ` · ${t('usageCost', { cost: formatCost(usage.costUsd) })}`;
  return `${tokens}${cost} · ${time}`;
}

program
  .command('logs')
  .description("print a task's log")
  .argument('<id>', 'task id', parseInteger)
  .option('-f, --follow', 'keep printing new events')
  .action(async (id: number, o: { follow?: boolean }) => {
    const api = client();
    const task = await api.getTask(id);
    const format = createEventFormatter(task.context?.window ?? config().fallbackContextWindow);
    let after = 0;
    for (;;) {
      const events = await api.events(id, after);
      for (const e of events) {
        const line = format(e.kind, e.data);
        if (line !== null) console.log(line);
        after = e.id;
      }
      if (!o.follow) return;
      await new Promise((resolve) => setTimeout(resolve, FOLLOW_INTERVAL_MS));
    }
  });

program
  .command('chat')
  .description(
    "write to a task's agent and print its reply (it may edit files); while the task is busy, the message waits until its current step ends",
  )
  .argument('<id>', 'task id', parseInteger)
  .argument('[message...]', 'your message; slash commands such as /compact are sent as-is')
  .option('--cancel', 'drop the messages still waiting to be sent')
  .action(async (id: number, words: string[], o: { cancel?: boolean }) => {
    const api = client();
    if (o.cancel) {
      await api.cancelChat(id);
      console.log(t('chatCancelled', { id }));
      return;
    }
    if (words.length === 0) throw new Error(t('chatNoMessage'));
    let seen = (await api.chat(id)).length + 1; // the message itself is echoed back first
    await api.sendChat(id, words.join(' '));
    if ((await api.chat(id)).at(-1)?.kind === 'pending') {
      console.log(t('chatQueued', { id }));
      return;
    }
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, FOLLOW_INTERVAL_MS));
      const entries = await api.chat(id);
      for (const entry of entries.slice(seen)) {
        if (entry.kind === 'agent') console.log(entry.text);
        if (entry.kind === 'tool') console.log(`  ⚙ ${entry.name} ${entry.summary}`);
        if (entry.kind === 'compact') console.log(t('chatCompacted', entry));
        if (entry.kind === 'end') {
          if (entry.reason !== 'completed') console.log(t('chatEnded', { reason: entry.reason }));
          return;
        }
      }
      seen = Math.max(seen, entries.length);
    }
  });

program
  .command('stop')
  .description('stop a running or queued task')
  .argument('<id>', 'task id', parseInteger)
  .action(async (id: number) => {
    await client().stopTask(id);
    console.log(t('stopRequested', { id }));
  });

program
  .command('models')
  .description("show or change a task's agents and models (only models while it runs)")
  .argument('<id>', 'task id', parseInteger)
  .option('--model <model>', 'implementer model, or "default" for the profile model')
  .option('--spec <agent>', 'spec author profile, or "implementer" to let the implementer write it')
  .option('--spec-model <model>', 'spec author model, or "default" for the profile model')
  .option('--reviewer <agent>', 'reviewer profile, or "none"')
  .option('--reviewer-model <model>', 'reviewer model, or "default" for the profile model')
  .action(async (id: number, o: ModelsOptions) => {
    const api = client();
    const model = (m?: string) => (m === undefined ? undefined : m === 'default' ? null : m);
    const update = definedOnly({
      implementerModel: model(o.model),
      spec: o.spec === undefined ? undefined : o.spec === 'implementer' ? null : o.spec,
      specModel: model(o.specModel),
      reviewer: o.reviewer === undefined ? undefined : o.reviewer === 'none' ? null : o.reviewer,
      reviewerModel: model(o.reviewerModel),
    });
    const task =
      Object.keys(update).length > 0 ? await api.setAgents(id, update) : await api.getTask(id);
    const a = task.agents;
    const shown = (m?: string | null) => m ?? t('defaultModel');
    console.log(
      a.spec
        ? `spec         ${a.spec}  ${shown(a.specModel)}`
        : `spec         ${t('sameAsImplementer')}`,
    );
    console.log(`implementer  ${a.implementer}  ${shown(a.implementerModel)}`);
    console.log(`reviewer     ${a.reviewer ?? '-'}  ${a.reviewer ? shown(a.reviewerModel) : ''}`);
  });

program
  .command('commits')
  .description("list the commits on a task's branch since its base, newest first")
  .argument('<id>', 'task id', parseInteger)
  .action(async (id: number) => {
    const commits = await client().commits(id);
    if (commits.length === 0) return console.log(t('noCommits', { id }));
    for (const c of commits) {
      const when = new Date(c.ts).toLocaleString();
      console.log(`${c.hash.slice(0, 8)}  ${c.subject}  (${c.author}, ${when})`);
    }
  });

program
  .command('allow')
  .description('allow a tool use the agent is waiting on')
  .argument('<id>', 'task id', parseInteger)
  .option('--rule <rules...>', 'also add these rules to the task, e.g. "Bash(npm *)"')
  .option('--suggested', 'also add the rules the agent suggested')
  .option(
    '--global',
    'add the rules (the suggested ones unless --rule is given) for every task instead of this one',
  )
  .option('--request <requestId>', 'which request, when several are waiting')
  .action(
    async (
      id: number,
      o: { rule?: string[]; suggested?: boolean; global?: boolean; request?: string },
    ) => {
      const api = client();
      const request = pickRequest(await api.getTask(id), o.request);
      // A global allow without rules would only allow this once, so it takes the suggestion.
      const suggested = o.suggested || (o.global && !o.rule);
      const rules = [...(suggested ? request.suggestedRules : []), ...(o.rule ?? [])];
      const task = await api.answerPermission(id, {
        requestId: request.requestId,
        behavior: 'allow',
        rules,
        ...(o.global ? { scope: 'global' as const } : {}),
      });
      console.log(t('taskStatus', { id, status: task.status }));
    },
  );

program
  .command('deny')
  .description('deny a tool use the agent is waiting on; the reason is passed to the agent')
  .argument('<id>', 'task id', parseInteger)
  .argument('[reason...]', 'why, so the agent can try something else')
  .option('--request <requestId>', 'which request, when several are waiting')
  .action(async (id: number, words: string[], o: { request?: string }) => {
    const api = client();
    const request = pickRequest(await api.getTask(id), o.request);
    const message = words.join(' ');
    const task = await api.answerPermission(id, {
      requestId: request.requestId,
      behavior: 'deny',
      ...(message ? { message } : {}),
    });
    console.log(t('taskStatus', { id, status: task.status }));
  });

program
  .command('tools')
  .description("show a task's allowed tools, or replace them while it is not running")
  .argument('<id>', 'task id', parseInteger)
  .argument('[rules...]', 'new tool rules, e.g. "Bash(npm *)" WebSearch')
  .option('--preset <ids>', 'add these permission presets, comma-separated', parsePresets)
  .action(async (id: number, rules: string[], o: { preset?: string[] }) => {
    const api = client();
    const task =
      rules.length > 0 || o.preset
        ? await api.setAllowedTools(id, [...presetRules(o.preset ?? []), ...rules])
        : await api.getTask(id);
    const list = task.permission.allowedTools;
    console.log(list.length > 0 ? list.join('\n') : t('noTools'));
  });

program
  .command('global-tools')
  .description('show the tool rules every task may use without asking, or replace them')
  .argument('[rules...]', 'new tool rules, e.g. "Bash(npm *)" WebSearch')
  .option('--preset <ids>', 'add these permission presets, comma-separated', parsePresets)
  .option('--clear', 'remove every global rule')
  .action(async (rules: string[], o: { preset?: string[]; clear?: boolean }) => {
    const api = client();
    const replace = o.clear || rules.length > 0 || o.preset;
    const settings = replace
      ? await api.saveSettings({ allowedTools: [...presetRules(o.preset ?? []), ...rules] })
      : await api.settings();
    const list = settings.allowedTools;
    console.log(list.length > 0 ? list.join('\n') : t('noTools'));
  });

program
  .command('auto')
  .description(
    'show or set whether a task allows unlisted tools without asking (dangerous ones still ask)',
  )
  .argument('<id>', 'task id', parseInteger)
  .addArgument(new Argument('[state]', 'on or off').choices(['on', 'off']))
  .action(async (id: number, state?: 'on' | 'off') => {
    const api = client();
    const task = state ? await api.setAutoApprove(id, state === 'on') : await api.getTask(id);
    console.log(t(task.permission.autoApprove ? 'autoOn' : 'autoOff', { id }));
  });

program
  .command('delete')
  .description(
    'delete a task that is not running, with its history and worktree (the branch is kept)',
  )
  .argument('<id>', 'task id', parseInteger)
  .action(async (id: number) => {
    const { branch } = await client().deleteTask(id);
    console.log(branch ? t('taskDeletedBranch', { id, branch }) : t('taskDeleted', { id }));
  });

program
  .command('resume')
  .description('queue a stopped, failed or reviewed task again')
  .argument('<id>', 'task id', parseInteger)
  .action(async (id: number) => {
    const task = await client().queueTask(id);
    console.log(t('taskStatus', { id, status: task.status }));
  });

program
  .command('done')
  .description('mark a reviewed task as done')
  .argument('<id>', 'task id', parseInteger)
  .action(async (id: number) => {
    const task = await client().completeTask(id);
    console.log(t('taskStatus', { id, status: task.status }));
  });

program
  .command('merge')
  .description('merge a reviewed task into its base branch and mark it done')
  .argument('<id>', 'task id', parseInteger)
  .action(async (id: number) => {
    const result = await client().mergeTask(id);
    if (result.status === 'merged') {
      console.log(t('merged', { id, base: result.base, commit: result.commit.slice(0, 8) }));
    } else {
      console.log(t('mergeConflicts', { id, base: result.base }));
      for (const file of result.files) console.log(`  ${file}`);
    }
  });

program
  .command('diff')
  .description('show what a task changed')
  .argument('<id>', 'task id', parseInteger)
  .action(async (id: number) => {
    const { diff, untracked } = await client().diff(id);
    if (!diff && untracked.length === 0) return console.log(t('emptyDiff'));
    process.stdout.write(diff);
    if (untracked.length > 0) console.log(`\n${t('untracked')}\n  ${untracked.join('\n  ')}`);
  });

program
  .command('open')
  .description("continue a task's latest session interactively in Claude Code")
  .argument('<id>', 'task id', parseInteger)
  .action(async (id: number) => {
    const task = await client().getTask(id);
    if (task.status === 'running') throw new Error(t('openWhileRunning', { id }));
    // Reviewer sessions are read-only; taking over means continuing the implementer's work.
    const session = task.sessions.findLast((s) => s.role === 'implementer' && s.agentSessionId);
    if (!session?.agentSessionId || !task.worktreePath) throw new Error(t('noSession', { id }));
    const profile = config().agents[session.agentId];
    if (!profile) throw new Error(t('unknownAgent', { agent: session.agentId }));
    const adapter = createAdapter(profile);
    console.log(t('opening', { session: session.agentSessionId, dir: task.worktreePath }));
    const child = spawn(adapter.command, adapter.interactiveResumeArgs(session.agentSessionId), {
      cwd: task.worktreePath,
      stdio: 'inherit',
    });
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
  });

interface LoopInput {
  mode?: 'loop';
  verifyCommand?: string;
  confirmPlan?: boolean;
}

interface AddOptions {
  repo: string;
  criteria?: string;
  title?: string;
  base?: string;
  size?: TaskSize;
  compact?: number;
  soft?: number;
  hard?: number;
  preset?: string[];
  allow?: string[];
  skipPermissions?: boolean;
  autoApprove?: boolean;
  reviewer?: string;
  model?: string;
  reviewerModel?: string;
  spec?: string;
  specModel?: string;
  queue: boolean;
}

interface ModelsOptions {
  model?: string;
  spec?: string;
  specModel?: string;
  reviewer?: string;
  reviewerModel?: string;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/** The request to answer: the given one, or the only one waiting. Throws otherwise. */
function pickRequest(task: TaskView, requestId?: string): PermissionRequest {
  const waiting = task.permissionRequests;
  const found = requestId ? waiting.find((r) => r.requestId === requestId) : waiting[0];
  if (!found) throw new Error(t('noPermissionRequest', { id: task.id }));
  if (!requestId && waiting.length > 1) {
    throw new Error(t('severalPermissionRequests', { id: task.id }));
  }
  return found;
}

/** Comma-separated preset ids; `none` for no preset. Unknown ids are rejected here. */
function parsePresets(value: string): string[] {
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id && id !== 'none');
  try {
    presetRules(ids);
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
  return ids;
}

/**
 * Rules to send, or `undefined` to let the server choose. `--allow` alone adds to the
 * default preset, so extra rules never silently take away the git commands.
 */
function allowedTools(presets?: string[], allow?: string[]): string[] | undefined {
  if (!presets && !allow) return undefined;
  return [...new Set([...presetRules(presets ?? [DEFAULT_PRESET]), ...(allow ?? [])])];
}

function parseInteger(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new InvalidArgumentError('not an integer');
  return n;
}

program.parseAsync().catch((err: unknown) => {
  const message =
    err instanceof ServerUnavailableError
      ? t('serverUnavailable', { url: err.message })
      : (err as Error).message;
  console.error(message);
  process.exit(1);
});

/** A question with its options lettered, so `hb feedback` can refer to them. */
function printQuestion(q: PlanQuestion): void {
  console.log(`  ? ${q.question}`);
  q.options.forEach((option, i) => console.log(`      ${String.fromCharCode(97 + i)}) ${option}`));
}
