// SPDX-License-Identifier: Apache-2.0
import spawn from 'cross-spawn';
import { Command, InvalidArgumentError, Option } from 'commander';
import { loadConfig } from '@harnessboard/core';
import type { HarnessConfig } from '@harnessboard/core';
import { APP_NAME, definedOnly } from '@harnessboard/shared';
import type { TaskSize } from '@harnessboard/shared';
import { ApiClient, ServerUnavailableError } from './client.js';
import { createEventFormatter, formatTaskRow, formatTokens } from './format.js';
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
    if (server.agent.ok) {
      console.log(t('agentFound', { command: cfg.claudePath, version: server.agent.version }));
    } else {
      console.warn(t('agentMissing', { command: cfg.claudePath, error: server.agent.error }));
    }
    console.log(t('serverStarted', { url: server.url }));
    const shutdown = () => void server.close().then(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

program
  .command('add')
  .description('create a task and queue it')
  .argument('<prompt...>', 'what the agent should do')
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
  .option('--no-queue', 'leave the task in the backlog')
  .action(async (words: string[], o: AddOptions) => {
    const task = await client().createTask(
      definedOnly({
        prompt: words.join(' '),
        repo: o.repo,
        title: o.title,
        baseRef: o.base,
        size: o.size,
        softPct: o.soft,
        hardPct: o.hard,
        allowedTools: o.allow,
        skipPermissions: o.skipPermissions,
        queue: o.queue,
      }),
    );
    console.log(t('taskCreated', { id: task.id, status: task.status }));
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
    for (const s of task.sessions) {
      console.log(
        `  session ${s.id}  ${s.endReason ?? 'active'}  ${formatTokens(s.contextTokens)}`,
      );
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
    if (!task.latestSessionId || !task.worktreePath) throw new Error(t('noSession', { id }));
    console.log(t('opening', { session: task.latestSessionId, dir: task.worktreePath }));
    const child = spawn(config().claudePath, ['--resume', task.latestSessionId], {
      cwd: task.worktreePath,
      stdio: 'inherit',
    });
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
  });

interface AddOptions {
  repo: string;
  title?: string;
  base?: string;
  size?: TaskSize;
  soft?: number;
  hard?: number;
  allow?: string[];
  skipPermissions?: boolean;
  queue: boolean;
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
