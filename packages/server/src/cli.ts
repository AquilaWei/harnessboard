// SPDX-License-Identifier: Apache-2.0
import spawn from 'cross-spawn';
import { Command, InvalidArgumentError, Option } from 'commander';
import { createAdapter, loadConfig, userConfigFile } from '@harnessboard/core';
import type { HarnessConfig } from '@harnessboard/core';
import { APP_NAME, definedOnly } from '@harnessboard/shared';
import type { TaskSize } from '@harnessboard/shared';
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
    .option('--base <ref>', 'git ref to branch from (defaults to the current branch)')
    .addOption(
      new Option('--size <size>', 'task size; sets the soft context threshold').choices([
        'small',
        'medium',
        'large',
      ]),
    )
    .option('--soft <pct>', 'soft context threshold in percent', parseInteger)
    .option('--hard <pct>', 'hard context threshold in percent', parseInteger)
    .option('--allow <rules...>', 'tool rules the agent may use without asking')
    .option('--skip-permissions', 'let the agent run anything (only in a sandbox)')
    .option('--reviewer <agent>', 'agent profile that reviews each finished step, or "none"')
    .option('--no-queue', 'leave the task in the backlog');
}

async function createTask(prompt: string, o: AddOptions, loop: LoopInput = {}): Promise<void> {
  const task = await client().createTask(
    definedOnly({
      prompt,
      ...loop,
      repo: o.repo,
      title: o.title,
      baseRef: o.base,
      size: o.size,
      softPct: o.soft,
      hardPct: o.hard,
      allowedTools: o.allow,
      skipPermissions: o.skipPermissions,
      reviewer: o.reviewer === 'none' ? null : o.reviewer,
      queue: o.queue,
    }),
  );
  console.log(t('taskCreated', { id: task.id, status: task.status }));
}

withTaskOptions(
  program
    .command('add')
    .description('create a task and queue it')
    .argument('<prompt...>', 'what the agent should do'),
).action((words: string[], o: AddOptions) => createTask(words.join(' '), o));

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
  .description("show a loop task's proposed plan, the planner's questions and reply")
  .argument('<id>', 'task id', parseInteger)
  .action(async (id: number) => {
    const plan = await client().plan(id);
    if (plan.reply) console.log(`${plan.reply}\n`);
    if (plan.error) console.log(`✗ ${plan.error}`);
    for (const feature of plan.features ?? []) {
      console.log(formatFeature(feature));
      for (const step of feature.steps ?? []) console.log(`        - ${step}`);
    }
    for (const q of plan.questions) console.log(`  ? ${q}`);
    if (plan.suggestedVerify) console.log(t('suggestedVerify', { command: plan.suggestedVerify }));
    if (!plan.approved) console.log(t('planNext', { id }));
  });

program
  .command('feedback')
  .description('reply to a proposed plan; the planner revises it')
  .argument('<id>', 'task id', parseInteger)
  .argument('<message...>', 'your feedback')
  .action(async (id: number, words: string[]) => {
    const task = await client().planFeedback(id, words.join(' '));
    console.log(t('taskStatus', { id, status: task.status }));
  });

program
  .command('approve')
  .description('approve a proposed plan and start building')
  .argument('<id>', 'task id', parseInteger)
  .option('--verify <command>', 'verify command to use (required unless the task has one)')
  .action(async (id: number, o: { verify?: string }) => {
    const task = await client().approvePlan(id, o.verify);
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
    if (task.context) {
      const c = task.context;
      const line = t('contextLine', {
        pct: c.pct,
        window: formatTokens(c.window),
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
  .command('stop')
  .description('stop a running or queued task')
  .argument('<id>', 'task id', parseInteger)
  .action(async (id: number) => {
    await client().stopTask(id);
    console.log(t('stopRequested', { id }));
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
}

interface AddOptions {
  repo: string;
  title?: string;
  base?: string;
  size?: TaskSize;
  soft?: number;
  hard?: number;
  allow?: string[];
  skipPermissions?: boolean;
  reviewer?: string;
  queue: boolean;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
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
