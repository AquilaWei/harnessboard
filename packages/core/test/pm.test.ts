// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PmConfig, Task } from '@harnessboard/shared';
import { resolveThresholds } from '@harnessboard/shared';
import { ClaudeCodeAdapter } from '../src/claude-code.js';
import { runSession } from '../src/runner.js';
import { FAKE_CLAUDE, init, result, writeScenario } from './helpers.js';
import { git } from '../src/worktree.js';
import { Store } from '../src/store.js';
import { PmWorkflow, pmWork, pmQuestion, validatePm } from '../src/pm.js';
import type { PmHost } from '../src/pm.js';
import type { SessionOutcome } from '../src/runner.js';
import { defaultConfig } from '../src/config.js';
import { makeRepo, tempDir } from './helpers.js';

let store: Store;
let task: Task;
let host: PmHost;
let controller: AbortController;
let engine: PmWorkflow;
const pm: PmConfig = {
  agentId: 'claude',
  model: null,
  effort: null,
  workers: [{ agentId: 'claude', models: [null] }],
};
const outcome: SessionOutcome = {
  reason: 'completed',
  finalText: 'done',
  quota: null,
  contextWindow: null,
  detail: null,
  usage: null,
};
const input = {
  agentId: 'claude',
  goal: 'Implement greeting',
  acceptance: 'Greeting works',
  scope: 'greeting.txt',
  access: 'edit',
};

beforeEach(() => {
  store = new Store(':memory:');
  controller = new AbortController();
  const repo = makeRepo();
  task = store.createTask({
    title: 'Greeting',
    prompt: 'Add greeting',
    repoPath: repo,
    baseRef: 'main',
    workspace: 'base',
    workflow: 'pm',
    pm,
    mode: 'single',
    verifyCommand: null,
    acceptance: '- greeting works',
    confirmPlan: true,
    contextPolicy: {},
    permission: { allowedTools: [], skipPermissions: false },
    agents: { implementer: 'claude', reviewer: null, maxReviewRounds: 2 },
  });
  task = store.updateTask(task.id, { worktreePath: repo });
  store.appendEvent(task.id, null, 'criteria_approved', { criteria: task.acceptance });
  host = {
    store,
    config: { ...defaultConfig({}), dataDir: tempDir('pm-unit') },
    run: vi.fn(async (_task, _plan, _id, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ...outcome, reason: 'stopped' as const };
    }),
    status: (_id, status) => {
      store.updateTask(task.id, { status });
    },
    blocked: () => false,
    permissions: () => [],
    answer: vi.fn(),
    notice: vi.fn(),
  };
  engine = new PmWorkflow(host, task, controller.signal);
});
afterEach(() => store.close());

function pmTurn(action: () => Promise<void>) {
  const worker = host.run;
  host.run = async (task, plan, id, signal) => {
    if (plan.role !== 'pm') return worker(task, plan, id, signal);
    try {
      await action();
    } finally {
      controller.abort();
    }
    return outcome;
  };
  return engine.run();
}

it('allows more than two read-only workers', async () => {
  await pmTurn(async () => {
    await engine.call('dispatch', { ...input, access: 'readOnly' });
    await engine.call('dispatch', { ...input, access: 'readOnly' });
    await engine.call('dispatch', { ...input, access: 'readOnly' });
  });
  expect(pmWork(store, task.id)).toHaveLength(3);
});

it('rejects waiting when no worker can produce an event', async () => {
  await pmTurn(async () => {
    await expect(engine.call('wait', {})).rejects.toThrow('No worker');
  });
});

it('fails after one corrective turn instead of inventing a user question', async () => {
  host.run = vi.fn(async () => outcome);
  await engine.run();
  expect(host.run).toHaveBeenCalledTimes(2);
  expect(store.getTask(task.id)?.status).toBe('failed');
  expect(store.lastEvent(task.id, 'pm_question')).toBeUndefined();
});

it('refuses models outside the task model pool', async () => {
  await pmTurn(async () => {
    await expect(engine.call('dispatch', { ...input, model: 'unapproved' })).rejects.toThrow(
      'not permitted',
    );
  });
  expect(pmWork(store, task.id)).toEqual([]);
});

it('requires a fresh approval after proposing a changed specification', async () => {
  store.appendEvent(task.id, null, 'criteria', { criteria: '- changed' });
  await pmTurn(async () => {
    await expect(engine.call('dispatch', input)).rejects.toThrow('User must approve');
  });
});

it('refuses acceptance while any child is running', async () => {
  await pmTurn(async () => {
    await engine.call('dispatch', input);
    await expect(engine.call('accept', {})).rejects.toThrow('Finish all child work');
  });
  expect(store.lastEvent(task.id, 'pm_acceptance')).toBeUndefined();
});

it('rejects tools after the PM turn has ended', async () => {
  await expect(engine.call('dispatch', input)).rejects.toThrow('PM turn has ended');
});

it('passes permission decisions without permanent rules or global scope', async () => {
  await pmTurn(async () => {
    host.permissions = () => [
      {
        requestId: 'r',
        sessionId: 'worker',
        ts: 100,
        toolName: 'Bash',
        summary: 'test',
        risk: null,
        suggestedRules: [],
      },
    ];
    await engine.call('permission', {
      sessionId: 'worker',
      ts: 100,
      requestId: 'r',
      behavior: 'deny',
      reason: 'Outside the approved scope.',
    });
  });
  expect(host.answer).toHaveBeenCalledWith(task.id, 'r', 'deny', 'Outside the approved scope.');
});

it('does not dispatch a quota-blocked worker', async () => {
  await pmTurn(async () => {
    host.blocked = () => true;
    await expect(engine.call('dispatch', input)).rejects.toThrow('waiting for quota');
  });
  expect(pmWork(store, task.id)).toEqual([]);
});

it('marks interrupted work stopped without replaying it after restart', async () => {
  store.appendEvent(task.id, null, 'pm_work', {
    ...input,
    id: 'old-work',
    parentSessionId: 'old-pm',
    sessionId: null,
    model: null,
    effort: null,
    status: 'running',
    summary: null,
    evidence: null,
    since: null,
    head: null,
    execution: 'managed',
  });
  const workerRun = host.run;
  await pmTurn(async () => {
    expect(pmWork(store, task.id)[0]?.status).toBe('stopped');
  });
  expect(workerRun).not.toHaveBeenCalled();
});

it('upgrades a pre-PM database with all tasks remaining legacy', () => {
  const file = path.join(tempDir('pm-upgrade'), 'harness.db');
  const initial = new Store(file);
  const saved = initial.createTask({ ...task, workflow: 'legacy' });
  initial.close();
  const db = new DatabaseSync(file);
  db.exec(
    'ALTER TABLE tasks DROP COLUMN workflow; ALTER TABLE tasks DROP COLUMN pm; PRAGMA user_version = 13;',
  );
  db.close();
  const upgraded = new Store(file);
  expect(upgraded.getTask(saved.id)).toMatchObject({
    workflow: 'legacy',
    pm: null,
    title: 'Greeting',
  });
  upgraded.close();
});

it('permits cross-platform workers while requiring a supported PM transport', () => {
  host.config.agents.gemini = { provider: 'gemini', command: 'gemini', model: null };
  expect(() =>
    validatePm(host.config, { ...pm, workers: [{ agentId: 'gemini', models: [null] }] }),
  ).not.toThrow();
});

it('records explicit cancellation so the PM can replace a failed worker', async () => {
  await pmTurn(async () => {
    const work = (await engine.call('dispatch', input)) as { id: string };
    await engine.call('cancel_work', { id: work.id });
  });
  expect(pmWork(store, task.id)[0]?.status).toBe('cancelled');
});

it('releases its task slot when an escalated question outlives the last worker', async () => {
  host.run = async (_task, plan) => {
    if (plan.role === 'secretary') {
      await workerTool(plan, 'escalate_pm', { message: 'Worker needs direct PM review.' });
      return outcome;
    }
    if (plan.role === 'pm') {
      if (pmQuestion(store, task.id)) return outcome;
      await engine.call('dispatch', { ...input, access: 'readOnly' });
      await engine.call('ask_user', { message: 'Please choose the final direction.' });
    }
    return outcome;
  };
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    await engine.run();
  } finally {
    clearTimeout(timer);
  }
  expect(store.getTask(task.id)?.status).toBe('awaiting_approval');
  expect(pmWork(store, task.id)[0]?.status).toBe('completed');
}, 3000);

it('reports PM acceptance for user review without marking the task done', async () => {
  const { headCommit } = await import('../src/worktree.js');
  const head = await headCommit(task.worktreePath!);
  store.appendEvent(task.id, null, 'pm_work', {
    ...input,
    id: 'completed-work',
    parentSessionId: 'old-pm',
    sessionId: 'worker-session',
    model: null,
    effort: null,
    status: 'completed',
    summary: 'Implemented',
    evidence: 'Tests pass',
    since: head,
    head,
    execution: 'managed',
  });
  host.run = vi.fn(async () => {
    await engine.call('accept', {
      head,
      summary: 'Greeting implemented',
      architecture: 'Architecture checked',
      functionality: 'Greeting works',
      verification: 'Tests pass',
    });
    return outcome;
  });
  await engine.run();
  expect(store.getTask(task.id)?.status).toBe('review');
  expect(store.lastEvent(task.id, 'pm_acceptance')?.data).toEqual({
    head,
    summary: 'Greeting implemented',
    architecture: 'Architecture checked',
    functionality: 'Greeting works',
    verification: 'Tests pass',
  });
});

it('runs PM permission decisions while an orphan branch has no HEAD', async () => {
  await git(task.worktreePath!, ['checkout', '--orphan', 'fresh-history']);
  await pmTurn(async () => {
    host.permissions = () => [
      {
        requestId: 'pending-first-commit',
        sessionId: 'worker',
        ts: 100,
        toolName: 'Bash',
        summary: 'test',
        risk: null,
        suggestedRules: [],
      },
    ];
    await engine.call('permission', {
      sessionId: 'worker',
      ts: 100,
      requestId: 'pending-first-commit',
      behavior: 'allow',
      reason: 'Approved new history.',
    });
  });
  expect(host.answer).toHaveBeenCalled();
});

it('runs a worker from an unborn branch through its first commit', async () => {
  await git(task.worktreePath!, ['checkout', '--orphan', 'fresh-history']);
  host.run = async (_task, plan) => {
    if (plan.role === 'secretary') {
      await workerTool(plan, 'escalate_pm', { message: 'Worker needs direct PM review.' });
      return outcome;
    }
    if (plan.role === 'pm') {
      if (pmQuestion(store, task.id)) return outcome;
      await engine.call('dispatch', input);
      await engine.call('ask_user', { message: 'Review the new history.' });
    } else {
      await git(task.worktreePath!, ['commit', '-m', 'chore: start fresh history']);
    }
    return outcome;
  };
  await engine.run();
  expect(pmWork(store, task.id)[0]).toMatchObject({ status: 'completed', since: null });
});

async function workerTool(
  plan: Parameters<PmHost['run']>[1],
  name: string,
  args: Record<string, unknown> = {},
) {
  const server = plan.mcpServers!.harnessboard!;
  const response = await fetch(server.env.HB_PM_ENDPOINT!, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${server.env.HB_PM_CAPABILITY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ method: 'tools/call', params: { name, arguments: args } }),
  });
  return response.json() as Promise<{ isError?: boolean; content: { text: string }[] }>;
}

it('hands shared write access to a child and resumes its parent after child completion', async () => {
  const order: string[] = [];
  let dispatched = false;
  let parentTurn = 0;
  host.run = async (_task, plan, id) => {
    store.setAgentSessionId(id, id);
    if (plan.role === 'secretary') {
      await workerTool(plan, 'escalate_pm', { message: 'Worker needs direct PM review.' });
      return outcome;
    }
    if (plan.role === 'pm') {
      if (pmQuestion(store, task.id)) return outcome;
      if (!dispatched) {
        dispatched = true;
        await engine.call('dispatch', input);
        await engine.call('wait', {});
      } else if (pmWork(store, task.id).some((w) => w.status !== 'completed')) {
        await engine.call('wait', {});
      } else {
        await engine.call('ask_user', { message: 'Please inspect the result.' });
      }
      return outcome;
    }
    const work = pmWork(store, task.id).find((w) => w.sessionId === id)!;
    if (work.parentWorkId) {
      order.push('child');
      await git(task.worktreePath!, ['commit', '--allow-empty', '-m', 'feat: complete child work']);
      return outcome;
    }
    parentTurn++;
    if (parentTurn === 1) {
      order.push('parent starts');
      const result = await workerTool(plan, 'dispatch', { ...input, goal: 'Child edit' });
      expect(result.isError).toBeUndefined();
      expect(pmWork(store, task.id)[1]?.status).toBe('queued');
      await workerTool(plan, 'wait');
      order.push('parent yields');
    } else {
      order.push('parent resumes');
      expect(plan.prompt).toContain('Resume your assigned work');
    }
    return outcome;
  };
  await engine.run();
  expect(order).toEqual(['parent starts', 'parent yields', 'child', 'parent resumes']);
  expect(pmWork(store, task.id).map((w) => w.status)).toEqual(['completed', 'completed']);
  expect(pmWork(store, task.id)[1]?.parentWorkId).toBe(pmWork(store, task.id)[0]?.id);
});

it('does not allow a read-only worker to delegate write access or PM decisions', async () => {
  host.run = async (_task, plan) => {
    if (plan.role === 'secretary') {
      await workerTool(plan, 'escalate_pm', { message: 'Worker needs direct PM review.' });
      return outcome;
    }
    if (plan.role === 'pm') {
      if (pmQuestion(store, task.id)) return outcome;
      await engine.call('dispatch', { ...input, access: 'readOnly' });
      await engine.call('ask_user', { message: 'Inspect analysis.' });
    } else {
      expect((await workerTool(plan, 'dispatch', input)).isError).toBe(true);
      expect((await workerTool(plan, 'ask_user', { message: 'Bypass PM?' })).isError).toBe(true);
      expect(
        (await workerTool(plan, 'permission', { requestId: 'r', behavior: 'allow', reason: 'x' }))
          .isError,
      ).toBe(true);
    }
    return outcome;
  };
  await engine.run();
  expect(pmWork(store, task.id)).toHaveLength(1);
  expect(host.answer).not.toHaveBeenCalled();
});

it('cancels a worker subtree including queued writers', async () => {
  host.run = async (_task, plan, id) => {
    if (plan.role === 'secretary') {
      await workerTool(plan, 'escalate_pm', { message: 'Worker needs direct PM review.' });
      return outcome;
    }
    if (plan.role === 'pm') {
      if (pmQuestion(store, task.id)) return outcome;
      if (pmWork(store, task.id).length === 0) {
        await engine.call('dispatch', input);
        await engine.call('wait', {});
      } else {
        await engine.call('cancel_work', { id: pmWork(store, task.id)[0]!.id });
        await engine.call('ask_user', { message: 'Work cancelled.' });
      }
    } else {
      await workerTool(plan, 'dispatch', { ...input, goal: 'Queued child' });
      await workerTool(plan, 'report_progress', { message: 'Child queued' });
      const work = pmWork(store, task.id).find((w) => w.sessionId === id)!;
      expect(work.parentWorkId).toBeNull();
      await workerTool(plan, 'wait');
    }
    return outcome;
  };
  await engine.run();
  expect(pmWork(store, task.id).map((w) => w.status)).toEqual(['cancelled', 'cancelled']);
});

it('sends historical failure state even when there are no new child events', async () => {
  store.appendEvent(task.id, null, 'pm_work', {
    ...input,
    id: 'failed-work',
    parentSessionId: 'saved-pm',
    sessionId: null,
    model: null,
    effort: null,
    status: 'failed',
    summary: 'Old worker crashed',
    evidence: null,
    since: null,
    head: null,
    execution: 'managed',
  });
  store.startSession('saved-pm', task.id, 'pm', 'claude', 'saved-pm');
  store.appendEvent(task.id, 'saved-pm', 'pm_turn', { hash: 'previous', fingerprints: {} });
  store.endSession('saved-pm', 'completed');
  host.run = async (_task, plan) => {
    expect(plan.prompt).toContain('Old worker crashed');
    expect(plan.prompt).toContain('Choose the number of managed workers');
    expect(plan.prompt).toContain('"status":"failed"');
    expect(plan.prompt).toContain('User has approved the current specification');
    expect(plan.resume?.id).toBe('saved-pm');
    await engine.call('ask_user', { message: 'A genuine external dependency needs a choice.' });
    return outcome;
  };
  await engine.run();
});

it('routes a worker escalation to the PM and resumes the same conversation with its answer', async () => {
  let dispatched = false;
  let workerTurns = 0;
  host.run = async (_task, plan, id) => {
    store.setAgentSessionId(id, id);
    if (plan.role === 'secretary') {
      await workerTool(plan, 'escalate_pm', { message: 'Worker needs direct PM review.' });
      return outcome;
    }
    if (plan.role === 'pm') {
      if (!dispatched) {
        dispatched = true;
        await engine.call('dispatch', { ...input, access: 'readOnly' });
        await engine.call('wait', {});
      } else {
        const work = pmWork(store, task.id)[0]!;
        if (work.status === 'awaiting_pm') {
          expect(plan.prompt).toContain('Which protocol version?');
          await engine.call('continue_work', { id: work.id, message: 'Use approved protocol v1.' });
          await engine.call('wait', {});
        } else if (work.status === 'completed') {
          await engine.call('ask_user', { message: 'Review findings.' });
        } else {
          await engine.call('wait', {});
        }
      }
    } else {
      workerTurns++;
      if (workerTurns === 1) {
        const reply = await workerTool(plan, 'ask_pm', { message: 'Which protocol version?' });
        expect(reply.isError).toBeUndefined();
      } else {
        expect(plan.prompt).toContain('Use approved protocol v1.');
      }
    }
    return outcome;
  };
  await engine.run();
  expect(workerTurns).toBe(2);
  expect(pmWork(store, task.id)[0]?.status).toBe('completed');
  expect(store.listSessions(task.id).filter((s) => s.role === 'worker')).toHaveLength(1);
});

it('joins multi-level delegated work before each parent completes', async () => {
  const order: string[] = [];
  const turns = new Map<string, number>();
  let dispatched = false;
  host.run = async (_task, plan, id) => {
    store.setAgentSessionId(id, id);
    if (plan.role === 'secretary') {
      await workerTool(plan, 'escalate_pm', { message: 'Worker needs direct PM review.' });
      return outcome;
    }
    if (plan.role === 'pm') {
      if (pmQuestion(store, task.id)) return outcome;
      if (!dispatched) {
        dispatched = true;
        await engine.call('dispatch', { ...input, access: 'readOnly' });
        await engine.call('wait', {});
      } else if (pmWork(store, task.id).some((w) => w.status !== 'completed')) {
        await engine.call('wait', {});
      } else {
        await engine.call('ask_user', { message: 'Review combined analysis.' });
      }
    } else {
      const work = pmWork(store, task.id).find((w) => w.sessionId === id)!;
      const turn = (turns.get(work.id) ?? 0) + 1;
      turns.set(work.id, turn);
      if (work.goal !== 'Leaf analysis' && turn === 1) {
        const goal = work.parentWorkId ? 'Leaf analysis' : 'Nested analysis';
        await workerTool(plan, 'dispatch', { ...input, goal, access: 'readOnly' });
        await workerTool(plan, 'wait');
      } else {
        order.push(work.goal);
      }
    }
    return outcome;
  };
  await engine.run();
  expect(order).toEqual(['Leaf analysis', 'Nested analysis', 'Implement greeting']);
  expect(pmWork(store, task.id).map((w) => w.status)).toEqual([
    'completed',
    'completed',
    'completed',
  ]);
});

it('delegates through real managed CLI processes and resumes only after the child exits', async () => {
  const scenario = writeScenario(tempDir('nested-cli'), [
    [
      [
        init('parent-thread'),
        {
          __pm: { name: 'dispatch', arguments: { ...input, goal: 'Implement delegated greeting' } },
        },
        { __pm: { name: 'wait' } },
        result('Waiting for delegated edit'),
      ],
    ],
    [
      [
        init('child-thread'),
        { __write: { path: 'greeting.txt', content: 'hello\n' } },
        { __commit: 'feat: add delegated greeting' },
        result('Greeting implemented and checked'),
      ],
    ],
    [[init('parent-thread'), result('Inspected child changes and verified greeting')]],
  ]);
  vi.stubEnv('FAKE_CLAUDE_SCENARIO', scenario);
  const adapter = new ClaudeCodeAdapter(FAKE_CLAUDE);
  let dispatched = false;
  host.run = async (_task, plan, id, signal) => {
    if (plan.role === 'secretary') {
      await workerTool(plan, 'escalate_pm', { message: 'Worker needs direct PM review.' });
      return outcome;
    }
    if (plan.role === 'pm') {
      if (!dispatched) {
        dispatched = true;
        await engine.call('dispatch', input);
        await engine.call('wait', {});
      } else if (pmWork(store, task.id).some((w) => w.status !== 'completed')) {
        await engine.call('wait', {});
      } else {
        await engine.call('ask_user', { message: 'Please review the integrated greeting.' });
      }
      return outcome;
    }
    return runSession({
      adapter,
      signal,
      thresholds: resolveThresholds({}),
      contextWindow: 100000,
      spec: {
        cwd: task.worktreePath!,
        sessionId: plan.resume?.agentSessionId ?? id,
        resume: !!plan.resume,
        prompt: plan.prompt,
        model: null,
        effort: null,
        access: plan.access,
        allowedTools: ['mcp__harnessboard__*'],
        skipPermissions: false,
        askPermission: false,
        managedWorker: true,
        mcpServers: plan.mcpServers!,
      },
      onEvent: (event) => {
        if (event.kind === 'init') store.setAgentSessionId(id, event.sessionId);
      },
      onNotice: () => {},
      onStderr: () => {},
    });
  };
  try {
    await engine.run();
    expect(pmWork(store, task.id).map((w) => w.status)).toEqual(['completed', 'completed']);
    expect(store.listSessions(task.id).filter((s) => s.role === 'worker')).toHaveLength(2);
    expect(pmWork(store, task.id)[0]?.summary).toBe(
      'Inspected child changes and verified greeting',
    );
    expect(await git(task.worktreePath!, ['show', 'HEAD:greeting.txt'])).toBe('hello\n');
  } finally {
    vi.unstubAllEnvs();
  }
});

it('requires explicit feature ownership before starting branch development', async () => {
  await pmTurn(async () => {
    await expect(engine.call('dispatch', { ...input, workspace: 'branch' })).rejects.toThrow(
      'writePaths',
    );
  });
  expect(pmWork(store, task.id)).toEqual([]);
});

it('rejects overlapping parallel feature ownership', async () => {
  await pmTurn(async () => {
    await engine.call('dispatch', { ...input, workspace: 'branch', writePaths: ['src/'] });
    await expect(
      engine.call('dispatch', { ...input, workspace: 'branch', writePaths: ['src/greeting.ts'] }),
    ).rejects.toThrow('overlaps');
  });
  expect(pmWork(store, task.id)).toHaveLength(1);
});

it('rejects path traversal in branch ownership', async () => {
  await pmTurn(async () => {
    await expect(
      engine.call('dispatch', { ...input, workspace: 'branch', writePaths: ['../outside/'] }),
    ).rejects.toThrow('relative');
  });
});

it('refuses branching from uncommitted source changes', async () => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(task.worktreePath!, 'pending.txt'), 'pending');
  await pmTurn(async () => {
    await expect(
      engine.call('dispatch', { ...input, workspace: 'branch', writePaths: ['src/'] }),
    ).rejects.toThrow('Commit source');
  });
});

it('runs independent writers concurrently from the same commit in private worktrees', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { headCommit } = await import('../src/worktree.js');
  const base = await headCommit(task.worktreePath!);
  let startA!: () => void;
  let startB!: () => void;
  let releaseWorkers!: () => void;
  const startedA = new Promise<void>((resolve) => {
    startA = resolve;
  });
  const startedB = new Promise<void>((resolve) => {
    startB = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseWorkers = resolve;
  });
  const directories: string[] = [];
  host.run = async (workerTask, plan) => {
    directories.push(plan.cwd!);
    expect(workerTask.worktreePath).toBe(plan.cwd);
    if (plan.prompt.includes('Feature A')) startA();
    else startB();
    await release;
    return outcome;
  };
  await pmTurn(async () => {
    try {
      await engine.call('dispatch', {
        ...input,
        goal: 'Feature A',
        workspace: 'branch',
        writePaths: ['a.txt'],
      });
      await startedA;
      await engine.call('dispatch', {
        ...input,
        goal: 'Feature B',
        workspace: 'branch',
        writePaths: ['b.txt'],
      });
      await startedB;
      expect(pmWork(store, task.id).map((w) => w.status)).toEqual(['running', 'running']);
      expect(directories[0]).not.toBe(directories[1]);
      expect(pmWork(store, task.id).map((w) => w.baseCommit)).toEqual([base, base]);
      await writeFile(path.join(directories[0]!, 'a.txt'), 'only in A');
      expect(await git(directories[1]!, ['status', '--porcelain'])).toBe('');
      expect(await git(task.worktreePath!, ['status', '--porcelain'])).toBe('');
    } finally {
      releaseWorkers();
    }
  });
});

it('integrates completed branch commits without losing independent sibling changes', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  host.run = async (_task, plan) => {
    const file = plan.prompt.includes('Feature A') ? 'a.txt' : 'b.txt';
    await writeFile(path.join(plan.cwd!, file), file);
    await git(plan.cwd!, ['add', file]);
    await git(plan.cwd!, ['commit', '-m', `feat: add ${file}`]);
    return outcome;
  };
  await pmTurn(async () => {
    const a = (await engine.call('dispatch', {
      ...input,
      goal: 'Feature A',
      workspace: 'branch',
      writePaths: ['a.txt'],
    })) as { id: string };
    const b = (await engine.call('dispatch', {
      ...input,
      goal: 'Feature B',
      workspace: 'branch',
      writePaths: ['b.txt'],
    })) as { id: string };
    await vi.waitFor(() =>
      expect(pmWork(store, task.id).map((w) => w.status)).toEqual(['completed', 'completed']),
    );
    await vi.waitFor(async () =>
      expect(await engine.call('integrate_work', { id: a.id })).toMatchObject({ integrated: true }),
    );
    await vi.waitFor(async () =>
      expect(await engine.call('integrate_work', { id: b.id })).toMatchObject({ integrated: true }),
    );
    expect(await readFile(path.join(task.worktreePath!, 'a.txt'), 'utf8')).toBe('a.txt');
    expect(await readFile(path.join(task.worktreePath!, 'b.txt'), 'utf8')).toBe('b.txt');
  });
});

it('blocks acceptance until completed branch delivery is integrated', async () => {
  const { writeFile } = await import('node:fs/promises');
  host.run = async (_task, plan) => {
    await writeFile(path.join(plan.cwd!, 'greeting.txt'), 'hello');
    await git(plan.cwd!, ['add', 'greeting.txt']);
    await git(plan.cwd!, ['commit', '-m', 'feat: add greeting']);
    return outcome;
  };
  await pmTurn(async () => {
    await engine.call('dispatch', { ...input, workspace: 'branch', writePaths: ['greeting.txt'] });
    await vi.waitFor(() => expect(pmWork(store, task.id)[0]?.status).toBe('completed'));
    await vi.waitFor(async () =>
      expect(engine.call('accept', {})).rejects.toThrow('Integrate completed'),
    );
  });
});

it('rejects delivery that modifies files outside its assigned feature', async () => {
  const { writeFile } = await import('node:fs/promises');
  host.run = async (_task, plan) => {
    await writeFile(path.join(plan.cwd!, 'outside.txt'), 'not owned');
    await git(plan.cwd!, ['add', 'outside.txt']);
    await git(plan.cwd!, ['commit', '-m', 'feat: change unrelated file']);
    return outcome;
  };
  await pmTurn(async () => {
    await engine.call('dispatch', { ...input, workspace: 'branch', writePaths: ['greeting.txt'] });
    await vi.waitFor(() =>
      expect(pmWork(store, task.id)[0]).toMatchObject({
        status: 'failed',
        summary: 'Worker changed paths outside its assigned feature: outside.txt',
      }),
    );
  });
});

it('reports merge conflicts while leaving the task branch and index untouched', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { headCommit } = await import('../src/worktree.js');
  await writeFile(path.join(task.worktreePath!, 'greeting.txt'), 'base\n');
  await git(task.worktreePath!, ['add', 'greeting.txt']);
  await git(task.worktreePath!, ['commit', '-m', 'feat: seed greeting']);
  host.run = async (_task, plan) => {
    await writeFile(
      path.join(plan.cwd!, 'greeting.txt'),
      plan.prompt.includes('Target edit') ? 'target\n' : 'worker\n',
    );
    await git(plan.cwd!, ['add', 'greeting.txt']);
    await git(plan.cwd!, ['commit', '-m', 'feat: change greeting']);
    return outcome;
  };
  await pmTurn(async () => {
    const work = (await engine.call('dispatch', {
      ...input,
      workspace: 'branch',
      writePaths: ['greeting.txt'],
    })) as { id: string };
    await vi.waitFor(() => expect(pmWork(store, task.id)[0]?.status).toBe('completed'));
    await engine.call('dispatch', { ...input, goal: 'Target edit' });
    await vi.waitFor(() =>
      expect(pmWork(store, task.id).map((w) => w.status)).toEqual(['completed', 'completed']),
    );
    const target = await headCommit(task.worktreePath!);
    await vi.waitFor(async () =>
      expect(await engine.call('integrate_work', { id: work.id })).toMatchObject({
        integrated: false,
        conflicts: ['greeting.txt'],
        targetHead: target,
      }),
    );
    expect(await headCommit(task.worktreePath!)).toBe(target);
    expect(await git(task.worktreePath!, ['status', '--porcelain'])).toBe('');
  });
});

it('continues a branch job in the same model conversation and worktree', async () => {
  const seen: string[] = [];
  host.run = async (_task, plan, id) => {
    store.setAgentSessionId(id, 'branch-thread');
    seen.push(`${plan.cwd}:${plan.resume?.agentSessionId ?? 'new'}`);
    return outcome;
  };
  await pmTurn(async () => {
    const work = (await engine.call('dispatch', {
      ...input,
      workspace: 'branch',
      writePaths: ['greeting.txt'],
    })) as { id: string };
    await vi.waitFor(() => expect(pmWork(store, task.id)[0]?.status).toBe('completed'));
    await vi.waitFor(async () =>
      engine.call('continue_work', { id: work.id, message: 'Verify additional acceptance case' }),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    const dir = pmWork(store, task.id)[0]!.worktreePath;
    expect(seen).toEqual([`${dir}:new`, `${dir}:branch-thread`]);
  });
});

it('refuses branch children outside their parent feature ownership', async () => {
  let refusal = '';
  host.run = async (_task, plan) => {
    const reply = await workerTool(plan, 'dispatch', {
      ...input,
      workspace: 'branch',
      writePaths: ['other/'],
    });
    refusal = reply.content[0]!.text;
    return outcome;
  };
  await pmTurn(async () => {
    await engine.call('dispatch', { ...input, workspace: 'branch', writePaths: ['src/'] });
    await vi.waitFor(() => expect(refusal).toContain('within parent ownership'));
  });
  expect(pmWork(store, task.id)).toHaveLength(1);
});

it('preserves a cancelled branch for explicit recovery', async () => {
  const { headCommit } = await import('../src/worktree.js');
  let branch = '';
  let directory = '';
  await pmTurn(async () => {
    const work = (await engine.call('dispatch', {
      ...input,
      workspace: 'branch',
      writePaths: ['src/'],
    })) as { id: string; branch: string; worktreePath: string };
    branch = work.branch;
    directory = work.worktreePath;
    await engine.call('cancel_work', { id: work.id });
  });
  expect(await headCommit(directory)).toBe(await headCommit(task.worktreePath!));
  expect(await git(directory, ['branch', '--show-current'])).toBe(`${branch}\n`);
  expect(pmWork(store, task.id)[0]?.status).toBe('cancelled');
});

it('allows a continued branch to inherit integrated sibling files without claiming them', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const { headCommit } = await import('../src/worktree.js');
  host.run = async (_task, plan, id) => {
    store.setAgentSessionId(id, id);
    if (plan.prompt.includes('Target edit')) {
      await writeFile(path.join(plan.cwd!, 'target.txt'), 'sibling');
      await git(plan.cwd!, ['add', 'target.txt']);
      await git(plan.cwd!, ['commit', '-m', 'feat: add sibling file']);
    } else {
      if (plan.resume)
        await git(plan.cwd!, [
          'merge',
          '--no-ff',
          '-m',
          'chore: inherit integrated changes',
          await headCommit(task.worktreePath!),
        ]);
      await writeFile(path.join(plan.cwd!, 'greeting.txt'), plan.resume ? 'Hello' : 'hello');
      await git(plan.cwd!, ['add', 'greeting.txt']);
      await git(plan.cwd!, ['commit', '-m', 'feat: update greeting']);
    }
    return outcome;
  };
  await pmTurn(async () => {
    const work = (await engine.call('dispatch', {
      ...input,
      workspace: 'branch',
      writePaths: ['greeting.txt'],
    })) as { id: string };
    await vi.waitFor(() => expect(pmWork(store, task.id)[0]?.status).toBe('completed'));
    await vi.waitFor(async () => engine.call('integrate_work', { id: work.id }));
    await engine.call('dispatch', { ...input, goal: 'Target edit' });
    await vi.waitFor(() => expect(pmWork(store, task.id)[1]?.status).toBe('completed'));
    await vi.waitFor(async () =>
      engine.call('continue_work', {
        id: work.id,
        message: 'Capitalize the greeting and merge latest target first.',
      }),
    );
    await vi.waitFor(() => expect(pmWork(store, task.id)[0]?.status).toBe('completed'));
    await vi.waitFor(async () => engine.call('integrate_work', { id: work.id }));
    expect(await readFile(path.join(task.worktreePath!, 'target.txt'), 'utf8')).toBe('sibling');
    expect(await readFile(path.join(task.worktreePath!, 'greeting.txt'), 'utf8')).toBe('Hello');
  });
});

it('rejects a PM decision after a request id is reused by another worker session', async () => {
  host.permissions = () => [
    {
      requestId: 'r',
      sessionId: 'replacement',
      ts: 200,
      toolName: 'Bash',
      summary: 'test',
      risk: null,
      suggestedRules: [],
    },
  ];
  await pmTurn(async () => {
    await expect(
      engine.call('permission', {
        requestId: 'r',
        sessionId: 'original',
        ts: 100,
        behavior: 'allow',
        reason: 'Old answer',
      }),
    ).rejects.toThrow('expired');
  });
  expect(host.answer).not.toHaveBeenCalled();
});
