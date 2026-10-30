// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PermissionRequest, PmWork, Task } from '@harnessboard/shared';
import { defaultConfig } from '../src/config.js';
import { PmWorkflow } from '../src/pm.js';
import { Secretary, pmSecretary } from '../src/pm-secretary.js';
import type { PmHost, PmSessionPlan } from '../src/pm.js';
import type { SessionOutcome } from '../src/runner.js';
import { Store } from '../src/store.js';
import { DISPATCH_PLAN, makeRepo, tempDir } from './helpers.js';

const completed: SessionOutcome = {
  reason: 'completed',
  finalText: 'done',
  quota: null,
  contextWindow: null,
  detail: null,
  usage: null,
};
let store: Store;
let task: Task;
let host: PmHost;
let engine: PmWorkflow;
let controller: AbortController;
let pending: PermissionRequest[];
const permission: PermissionRequest = {
  requestId: 'r1',
  sessionId: 'worker-session',
  toolName: 'Bash',
  summary: 'cargo test',
  suggestedRules: [],
  risk: null,
  ts: 100,
};

beforeEach(() => {
  store = new Store(':memory:');
  const repo = makeRepo();
  task = store.createTask({
    title: 'Secretary',
    prompt: 'Check greeting',
    repoPath: repo,
    baseRef: 'main',
    workspace: 'base',
    workflow: 'pm',
    mode: 'single',
    verifyCommand: null,
    acceptance: 'Check greeting',
    confirmPlan: true,
    contextPolicy: {},
    permission: { allowedTools: [], skipPermissions: false },
    agents: { implementer: 'claude', reviewer: null, maxReviewRounds: 2 },
    pm: {
      agentId: 'claude',
      model: 'large',
      effort: null,
      workers: [{ agentId: 'claude', models: ['small'] }],
    },
  });
  task = store.updateTask(task.id, { worktreePath: repo });
  store.appendEvent(task.id, null, 'criteria_approved', { criteria: task.acceptance });
  controller = new AbortController();
  pending = [];
  host = {
    store,
    config: { ...defaultConfig({}), dataDir: tempDir('secretary-routing') },
    run: vi.fn(),
    blocked: () => false,
    permissions: () => pending,
    answer: vi.fn(() => {
      pending = [];
    }),
    notice: vi.fn(),
    status: (_id, status) => {
      store.updateTask(task.id, { status });
    },
  };
  engine = new PmWorkflow(host, task, controller.signal);
});
afterEach(() => store.close());

async function rpc(plan: PmSessionPlan, name: string, args: Record<string, unknown>) {
  const server = plan.mcpServers!.harnessboard!;
  const response = await fetch(server.env.HB_PM_ENDPOINT!, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.env.HB_PM_CAPABILITY}` },
    body: JSON.stringify({ method: 'tools/call', params: { name, arguments: args } }),
  });
  const result = (await response.json()) as { isError?: boolean; content: { text: string }[] };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result;
}

it('handles a routine permission without restarting the PM until worker delivery', async () => {
  let approve!: () => void;
  const approved = new Promise<void>((resolve) => {
    approve = resolve;
  });
  host.answer = vi.fn(() => {
    pending = [];
    approve();
  });
  let pmRuns = 0;
  let secretaryRuns = 0;
  host.run = vi.fn(async (_task, plan) => {
    if (plan.role === 'pm') {
      pmRuns++;
      if (pmRuns === 1) {
        await engine.call('appoint_secretary', { agentId: 'claude', model: 'small' });
        await engine.call('dispatch', {
          plan: DISPATCH_PLAN,
          workspace: 'shared',
          agentId: 'claude',
          model: 'small',
          goal: 'Check',
          acceptance: 'Checked',
          scope: 'greeting',
          access: 'readOnly',
        });
        await engine.call('wait', {});
      } else controller.abort();
    } else if (String(plan.role) === 'secretary') {
      secretaryRuns++;
      expect(pmRuns).toBe(1);
      expect(plan.resume).toBeNull();
      if (secretaryRuns === 2) {
        await rpc(plan, 'escalate_pm', { message: 'Delivery ready for PM review.' });
        return completed;
      }
      await rpc(plan, 'permission', {
        requestId: 'r1',
        sessionId: 'worker-session',
        ts: 100,
        behavior: 'allow',
        reason: 'Approved test command.',
      });
      await rpc(plan, 'finish_batch', { summary: 'Allowed the approved test command.' });
    } else {
      pending = [permission];
      engine.notify('routine');
      await approved;
    }
    return completed;
  });
  await engine.run();
  expect(pmRuns).toBe(2);
  expect(secretaryRuns).toBe(2);
  expect(host.answer).toHaveBeenCalledWith(
    task.id,
    'r1',
    'allow',
    'Approved test command.',
    'secretary',
  );
});

it('rejects appointing a secretary outside the permitted model pool', async () => {
  host.run = vi.fn(async () => {
    await expect(
      engine.call('appoint_secretary', { agentId: 'claude', model: 'unapproved' }),
    ).rejects.toThrow('not permitted');
    controller.abort();
    return completed;
  });
  await engine.run();
});

function secretary() {
  const secretary = new Secretary(host, task.id, controller.signal);
  secretary.appoint({ agentId: 'claude', model: 'small' }, 'pm-session');
  return secretary;
}

it('does not start a model when there is no routine work', async () => {
  const assistant = secretary();
  expect(await assistant.handle()).toBe(false);
  expect(host.run).not.toHaveBeenCalled();
});

it('does not start a secretary model for pure worker progress', async () => {
  const assistant = secretary();
  store.appendEvent(task.id, 'worker-session', 'pm_progress', { message: 'Compiled' });
  store.appendEvent(task.id, 'worker-session', 'pm_progress', { message: 'Tests running' });
  host.run = vi.fn();
  expect(await assistant.handle()).toBe(false);
  expect(await assistant.handle()).toBe(false);
  expect(host.run).not.toHaveBeenCalled();
});

it('keeps events arriving during a batch for the next fresh conversation', async () => {
  const assistant = secretary();
  store.appendEvent(task.id, null, 'pm_progress', { message: 'First milestone' });
  store.appendEvent(task.id, null, 'pm_worker_update', {
    ...assignedWork(),
    parentWorkId: 'parent',
    status: 'completed',
  });
  host.run = vi.fn(async (_task, plan) => {
    store.appendEvent(task.id, null, 'pm_progress', { message: 'Second milestone' });
    store.appendEvent(task.id, null, 'pm_worker_update', {
      ...assignedWork(),
      parentWorkId: 'parent',
      status: 'completed',
    });
    await rpc(plan, 'finish_batch', { summary: 'First milestone recorded.' });
    return completed;
  });
  await assistant.handle();
  host.run = vi.fn(async (_task, plan) => {
    expect(plan.prompt).toContain('Second milestone');
    expect(plan.prompt).not.toContain('First milestone');
    expect(plan.resume).toBeNull();
    await rpc(plan, 'finish_batch', { summary: 'Second milestone recorded.' });
    return completed;
  });
  await assistant.handle();
  expect(store.listSessions(task.id).map((s) => s.role)).toEqual(['secretary', 'secretary']);
});

it('rejects stale permissions when another session reuses a request id', async () => {
  const assistant = secretary();
  pending = [permission];
  host.run = vi.fn(async (_task, plan) => {
    pending = [{ ...permission, sessionId: 'different-worker', ts: 200 }];
    await expect(
      rpc(plan, 'permission', {
        requestId: 'r1',
        sessionId: 'worker-session',
        ts: 100,
        behavior: 'allow',
        reason: 'Run tests',
      }),
    ).rejects.toThrow('expired');
    await rpc(plan, 'escalate_pm', { message: 'Permission changed; inspect the current worker.' });
    return completed;
  });
  expect(await assistant.handle()).toBe(true);
  expect(host.answer).not.toHaveBeenCalled();
});

it('forwards risky permissions to the PM without starting the secretary', async () => {
  const assistant = secretary();
  pending = [{ ...permission, risk: 'grants additional filesystem or network access' }];
  expect(await assistant.handle()).toBe(true);
  expect(host.run).not.toHaveBeenCalled();
  expect(store.eventsOfKind(task.id, 'pm_secretary_escalation')).toHaveLength(1);
});

it('enforces the secretary tool boundary even when it calls an unlisted tool', async () => {
  const assistant = secretary();
  pending = [permission];
  host.run = vi.fn(async (_task, plan) => {
    await expect(rpc(plan, 'dispatch', {})).rejects.toThrow('not available');
    await expect(rpc(plan, 'accept', {})).rejects.toThrow('not available');
    await rpc(plan, 'escalate_pm', { message: 'Need a PM decision.' });
    await expect(rpc(plan, 'permission', { requestId: 'r1' })).rejects.toThrow('has ended');
    return completed;
  });
  expect(await assistant.handle()).toBe(true);
  expect(host.answer).not.toHaveBeenCalled();
});

it('refuses decisions after the specification changes during a batch', async () => {
  const assistant = secretary();
  pending = [permission];
  host.run = vi.fn(async (_task, plan) => {
    store.appendEvent(task.id, null, 'criteria', { criteria: 'Different scope' });
    await expect(
      rpc(plan, 'permission', {
        requestId: 'r1',
        sessionId: 'worker-session',
        ts: 100,
        behavior: 'allow',
        reason: 'Run tests',
      }),
    ).rejects.toThrow('Specification changed');
    return completed;
  });
  expect(await assistant.handle()).toBe(true);
  expect(host.answer).not.toHaveBeenCalled();
});

it('suspends a failed secretary and escalates once instead of retrying its model', async () => {
  const assistant = secretary();
  pending = [permission];
  host.run = vi.fn(async () => ({ ...completed, reason: 'quota' as const }));
  expect(await assistant.handle()).toBe(true);
  expect(await assistant.handle()).toBe(true);
  expect(host.run).toHaveBeenCalledTimes(1);
  expect(pmSecretary(store, task.id)?.status).toBe('failed');
  expect(store.eventsOfKind(task.id, 'pm_secretary_escalation')).toHaveLength(1);
});

it('restores the appointment and skips completed batches after restart', async () => {
  const assistant = secretary();
  store.appendEvent(task.id, null, 'pm_progress', { message: 'Already handled' });
  store.appendEvent(task.id, null, 'pm_worker_update', {
    ...assignedWork(),
    parentWorkId: 'parent',
    status: 'completed',
  });
  host.run = vi.fn(async (_task, plan) => {
    await rpc(plan, 'finish_batch', { summary: 'Recorded progress.' });
    return completed;
  });
  await assistant.handle();
  const restored = new Secretary(host, task.id, controller.signal);
  restored.recover();
  expect(await restored.handle()).toBe(false);
  expect(restored.state?.model).toBe('small');
  expect(host.run).toHaveBeenCalledTimes(1);
});

it('does not acknowledge an interrupted batch and preserves pending requests', async () => {
  const assistant = secretary();
  pending = [permission];
  host.run = vi.fn(async () => {
    controller.abort();
    return { ...completed, reason: 'stopped' as const };
  });
  expect(await assistant.handle()).toBe(false);
  expect(store.eventsOfKind(task.id, 'pm_secretary_batch_end')).toHaveLength(0);
  expect(pmSecretary(store, task.id)?.status).toBe('waiting');
  expect(pending).toEqual([permission]);
});

it('preempts routine approvals immediately when a PM decision arrives', async () => {
  const assistant = secretary();
  pending = [permission];
  host.run = vi.fn(async (_task, plan, _id, signal) => {
    assistant.interrupt();
    expect(signal.aborted).toBe(true);
    await expect(
      rpc(plan, 'permission', {
        requestId: 'r1',
        sessionId: 'worker-session',
        ts: 100,
        behavior: 'allow',
        reason: 'Run tests',
      }),
    ).rejects.toThrow('has ended');
    return { ...completed, reason: 'stopped' as const };
  });
  expect(await assistant.handle()).toBe(true);
  expect(assistant.state?.status).toBe('waiting');
  expect(host.answer).not.toHaveBeenCalled();
});

it('suspends a batch that exceeds its time limit without retrying the model', async () => {
  const assistant = secretary();
  pending = [permission];
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  host.run = vi.fn(async (_task, _plan, _id, signal) => {
    started();
    return new Promise<SessionOutcome>((resolve) =>
      signal.addEventListener('abort', () => resolve({ ...completed, reason: 'stopped' }), {
        once: true,
      }),
    );
  });
  vi.useFakeTimers();
  try {
    const run = assistant.handle();
    await ready;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await run).toBe(true);
    expect(assistant.state?.summary).toContain('exceeded 60 seconds');
    expect(assistant.state?.status).toBe('failed');
    expect(host.run).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('offers appointment to an existing PM without resending its initial instructions', async () => {
  store.startSession('existing-pm', task.id, 'pm', 'claude', 'old-thread');
  store.appendEvent(task.id, 'existing-pm', 'pm_turn', {});
  store.endSession('existing-pm', 'completed');
  host.run = vi.fn(async (_task, plan) => {
    expect(plan.prompt).toContain('appoint_secretary');
    expect(plan.prompt).not.toContain('sole user-facing coordinator');
    controller.abort();
    return completed;
  });
  await engine.run();
});

it('appoints a permitted secretary before dispatch even when the PM omits appointment', async () => {
  host.run = vi.fn(async (_task, plan) => {
    if (plan.role === 'pm') {
      await engine.call('dispatch', {
        plan: DISPATCH_PLAN,
        workspace: 'shared',
        agentId: 'claude',
        model: 'small',
        goal: 'Check',
        acceptance: 'Checked',
        scope: 'greeting',
        access: 'readOnly',
      });
      expect(pmSecretary(store, task.id)?.model).toBe('small');
      controller.abort();
    }
    return completed;
  });
  await engine.run();
});

it('routes an uncertain worker question through the secretary before the PM answers directly', async () => {
  let pmRuns = 0;
  let secretaryRuns = 0;
  let workId = '';
  host.run = vi.fn(async (_task, plan) => {
    if (plan.role === 'pm') {
      pmRuns++;
      if (pmRuns === 1) {
        const work = (await engine.call('dispatch', {
          plan: DISPATCH_PLAN,
          workspace: 'shared',
          agentId: 'claude',
          model: 'small',
          goal: 'Check',
          acceptance: 'Checked',
          scope: 'greeting',
          access: 'readOnly',
        })) as { id: string };
        workId = work.id;
        await engine.call('wait', {});
      } else {
        expect(secretaryRuns).toBe(1);
        expect(plan.prompt).toContain('Need an architecture decision');
        await engine.call('continue_work', {
          id: workId,
          message: 'PM directly chooses option A.',
        });
        expect(store.lastEvent(task.id, 'pm_worker_direction')?.data).toEqual({
          workId,
          message: 'PM directly chooses option A.',
        });
        controller.abort();
      }
    } else if (plan.role === 'secretary') {
      secretaryRuns++;
      expect(pmRuns).toBe(1);
      expect(plan.prompt).toContain('Choose architecture A or B?');
      await expect(rpc(plan, 'finish_batch', { summary: 'Ignored question' })).rejects.toThrow(
        'escalate',
      );
      await rpc(plan, 'escalate_pm', { message: 'Need an architecture decision' });
    } else {
      await rpc(plan, 'ask_pm', { message: 'Choose architecture A or B?' });
    }
    return completed;
  });
  await engine.run();
  expect(secretaryRuns).toBe(1);
  expect(pmRuns).toBe(2);
});

it('answers an explicit question without waking the PM and escalates its unresolved follow-up', async () => {
  task = store.updateTask(task.id, { acceptance: 'The greeting must be exactly Hello world.' });
  let pmRuns = 0;
  let workerRuns = 0;
  let secretaryRuns = 0;
  host.run = vi.fn(async (_task, plan) => {
    if (plan.role === 'pm') {
      pmRuns++;
      if (pmRuns === 1) {
        await engine.call('dispatch', {
          plan: DISPATCH_PLAN,
          workspace: 'shared',
          agentId: 'claude',
          model: 'small',
          goal: 'Check',
          acceptance: 'Checked',
          scope: 'greeting',
          access: 'readOnly',
        });
        await engine.call('wait', {});
      } else {
        expect(workerRuns).toBe(2);
        expect(secretaryRuns).toBe(2);
        expect(plan.prompt).toContain('Still unclear');
        controller.abort();
      }
    } else if (plan.role === 'secretary') {
      secretaryRuns++;
      const updates = store.eventsOfKind(task.id, 'pm_worker_update');
      const id = (updates.at(-1)!.data as { id: string }).id;
      if (secretaryRuns === 1) {
        await expect(
          rpc(plan, 'reply_worker', { id, quote: 'Invented requirement' }),
        ).rejects.toThrow('verbatim');
        await rpc(plan, 'reply_worker', { id, quote: 'The greeting must be exactly Hello world.' });
        await rpc(plan, 'finish_batch', { summary: 'Quoted the exact approved greeting.' });
      } else {
        await expect(
          rpc(plan, 'reply_worker', { id, quote: 'The greeting must be exactly Hello world.' }),
        ).rejects.toThrow('escalate');
        await rpc(plan, 'escalate_pm', {
          message: 'Still unclear; PM must answer the original worker.',
        });
      }
    } else {
      workerRuns++;
      expect(pmRuns).toBe(1);
      if (workerRuns === 1) await rpc(plan, 'ask_pm', { message: 'What greeting should I check?' });
      else {
        expect(plan.prompt).toContain('Secretary: existing approved instructions state:');
        await rpc(plan, 'ask_pm', {
          message: 'Still unclear; does this apply to translated text?',
        });
      }
    }
    return completed;
  });
  await engine.run();
  expect(pmRuns).toBe(2);
  expect(workerRuns).toBe(2);
  expect(store.eventsOfKind(task.id, 'pm_secretary_reply')).toHaveLength(1);
});

it('cannot hide a worker delivery by finishing a secretary batch', async () => {
  const assistant = secretary();
  store.appendEvent(task.id, 'worker-session', 'pm_worker_update', {
    id: 'delivered',
    status: 'completed',
    summary: 'Tests passed',
    evidence: '/evidence/delivery.txt',
  });
  host.run = vi.fn(async (_task, plan) => {
    expect(plan.prompt).toContain('/evidence/delivery.txt');
    await expect(rpc(plan, 'finish_batch', { summary: 'Done' })).rejects.toThrow('escalate');
    await rpc(plan, 'escalate_pm', { message: 'Review worker delivery.' });
    return completed;
  });
  expect(await assistant.handle()).toBe(true);
  expect(store.lastEvent(task.id, 'pm_secretary_escalation')?.data).toMatchObject({
    workers: [{ id: 'delivered', evidence: '/evidence/delivery.txt' }],
  });
});

it('records a visible fallback when no permitted local secretary can run', () => {
  host.config.agents.claude = { provider: 'gemini', command: 'gemini', model: null };
  const assistant = new Secretary(host, task.id, controller.signal);
  assistant.ensure('pm-session');
  assistant.ensure('pm-session');
  expect(assistant.state).toBeNull();
  expect(host.notice).toHaveBeenCalledTimes(1);
  expect(store.eventsOfKind(task.id, 'pm_secretary_unavailable')).toHaveLength(1);
});

it('does not spend secretary tokens on the PM own progress messages', async () => {
  const assistant = secretary();
  store.appendEvent(task.id, 'pm-session', 'pm_progress', { workId: null, message: 'User update' });
  expect(await assistant.handle()).toBe(false);
  expect(host.run).not.toHaveBeenCalled();
});

it('prefers a permitted lightweight model over the first large model', () => {
  store.updateTask(task.id, {
    pm: { ...task.pm!, workers: [{ agentId: 'claude', models: ['large', 'small'] }] },
  });
  const assistant = new Secretary(host, task.id, controller.signal);
  assistant.ensure('pm-session');
  expect(assistant.state?.model).toBe('small');
});

function assignedWork(): PmWork {
  return {
    id: 'assigned',
    parentSessionId: 'pm-session',
    parentWorkId: null,
    sessionId: 'worker-session',
    agentId: 'claude',
    model: 'small',
    effort: null,
    goal: 'Implement TheraNote export and import.',
    acceptance: 'Mask every student name and pass export tests.',
    scope: 'Edit src/datafuzzy/ot/ and tests/test_ot_*.py only.',
    access: 'edit',
    status: 'running',
    summary: null,
    evidence: null,
    since: null,
    head: null,
    execution: 'managed',
  };
}

it('supplies the initial assignment for a permission-only batch after restart', async () => {
  secretary();
  const work = assignedWork();
  store.appendEvent(task.id, work.sessionId, 'pm_work', work);
  store.appendEvent(task.id, null, 'pm_work', { ...work, sessionId: 'new-worker-session' });
  store.appendEvent(task.id, null, 'pm_work', {
    ...work,
    id: 'unrelated',
    sessionId: 'other-session',
    goal: 'UNRELATED_PRIVATE_GOAL',
  });
  const restarted = new Secretary(host, task.id, controller.signal);
  restarted.recover();
  pending = [permission];
  let prompt = '';
  host.run = vi.fn(async (_task, plan) => {
    prompt = plan.prompt;
    await rpc(plan, 'escalate_pm', { message: 'Inspect assignment.' });
    return completed;
  });
  expect(await restarted.handle()).toBe(true);
  expect(prompt).toContain(work.goal);
  expect(prompt).toContain(work.acceptance);
  expect(prompt).toContain(work.scope);
  expect(prompt).not.toContain('UNRELATED_PRIVATE_GOAL');
  expect(restarted.state?.status).toBe('waiting');
});

it('includes PM follow-up directions for delivery batches without unrelated directions', async () => {
  const assistant = secretary();
  const work: PmWork = { ...assignedWork(), parentWorkId: 'parent', status: 'completed' };
  store.appendEvent(task.id, work.sessionId, 'pm_work', work);
  store.appendEvent(task.id, 'pm-session', 'pm_worker_direction', {
    workId: work.id,
    message: 'After acceptance, bump the version to 0.1.0.',
  });
  store.appendEvent(task.id, 'pm-session', 'pm_worker_direction', {
    workId: 'other',
    message: 'UNRELATED_PRIVATE_DIRECTION',
  });
  store.appendEvent(task.id, work.sessionId, 'pm_progress', {
    workId: work.id,
    message: 'Preparing the version commit.',
  });
  store.appendEvent(task.id, work.sessionId, 'pm_worker_update', work);
  host.run = vi.fn(async (_task, plan) => {
    expect(plan.prompt).toContain(work.scope);
    expect(plan.prompt).toContain('After acceptance, bump the version to 0.1.0.');
    expect(plan.prompt).not.toContain('UNRELATED_PRIVATE_DIRECTION');
    await rpc(plan, 'finish_batch', { summary: 'Progress recorded.' });
    return completed;
  });
  expect(await assistant.handle()).toBe(false);
});

it('permits a verbatim answer from a durable PM follow-up', async () => {
  const reply = vi.fn();
  const assistant = new Secretary(host, task.id, controller.signal, reply);
  assistant.appoint({ agentId: 'claude', model: 'small' }, 'pm-session');
  const work = { ...assignedWork(), status: 'awaiting_pm' as const };
  store.appendEvent(task.id, work.sessionId, 'pm_work', work);
  store.appendEvent(task.id, 'pm-session', 'pm_worker_direction', {
    workId: work.id,
    message: 'Mask all students, including students outside the selected dates.',
  });
  store.appendEvent(task.id, work.sessionId, 'pm_worker_update', work);
  host.run = vi.fn(async (_task, plan) => {
    await rpc(plan, 'reply_worker', {
      id: work.id,
      quote: 'Mask all students, including students outside the selected dates.',
    });
    await rpc(plan, 'finish_batch', { summary: 'Quoted PM direction.' });
    return completed;
  });
  expect(await assistant.handle()).toBe(false);
  expect(reply).toHaveBeenCalledWith(work, expect.stringContaining('Mask all students'));
});

it('persists PM directions when continuing completed work and rejects invalid continuations', async () => {
  const work = { ...assignedWork(), status: 'completed' as const };
  store.appendEvent(task.id, work.sessionId, 'pm_work', work);
  host.run = vi.fn(async (_task, plan) => {
    if (plan.role === 'pm') {
      await expect(engine.call('continue_work', { id: work.id, message: '' })).rejects.toThrow();
      expect(store.eventsOfKind(task.id, 'pm_worker_direction')).toHaveLength(0);
      await engine.call('continue_work', {
        id: work.id,
        message: 'Build the approved UI and package version 0.7.0.0.1.',
      });
      expect(store.lastEvent(task.id, 'pm_worker_direction')?.data).toEqual({
        workId: work.id,
        message: 'Build the approved UI and package version 0.7.0.0.1.',
      });
      controller.abort();
    }
    return completed;
  });
  await engine.run();
});

it('hands an omitted batch finish to the PM without disabling the secretary', async () => {
  const assistant = secretary();
  pending = [permission];
  host.run = vi.fn(async (_task, plan) => {
    await rpc(plan, 'permission', {
      requestId: 'r1',
      sessionId: 'worker-session',
      ts: 100,
      behavior: 'allow',
      reason: 'Approved verification.',
    });
    return completed;
  });
  expect(await assistant.handle()).toBe(true);
  expect(assistant.state?.status).toBe('waiting');
  expect(store.eventsOfKind(task.id, 'pm_secretary_escalation')).toHaveLength(1);
  expect(store.listSessions(task.id)[0]?.endReason).toBe('completed');
});

it('preserves unanswered permissions when a completed secretary omits batch finish', async () => {
  const assistant = secretary();
  pending = [permission];
  host.run = vi.fn(async () => completed);
  expect(await assistant.handle()).toBe(true);
  expect(pending).toEqual([permission]);
  expect(host.answer).not.toHaveBeenCalled();
  expect(assistant.state?.status).toBe('waiting');
  expect(store.eventsOfKind(task.id, 'pm_secretary_escalation')).toHaveLength(1);
});

it('reviews worker permissions while the PM waits for an installation answer', async () => {
  let approve!: () => void;
  const approved = new Promise<void>((resolve) => {
    approve = resolve;
  });
  host.answer = vi.fn(() => {
    pending = [];
    approve();
  });
  host.run = vi.fn(async (_task, plan) => {
    if (plan.role === 'pm') {
      await engine.call('dispatch', {
        plan: DISPATCH_PLAN,
        workspace: 'shared',
        agentId: 'claude',
        model: 'small',
        goal: 'Screenshot',
        acceptance: 'Screenshot captured',
        scope: 'browser',
        access: 'readOnly',
      });
      await engine.call('ask_user', { message: 'Install the browser tool?' });
    } else if (plan.role === 'secretary') {
      await rpc(plan, 'permission', {
        requestId: 'r1',
        sessionId: 'worker-session',
        ts: 100,
        behavior: 'allow',
        reason: 'Approved screenshot operation.',
      });
      await rpc(plan, 'finish_batch', { summary: 'Screenshot permission reviewed.' });
      controller.abort();
    } else {
      pending = [permission];
      engine.notify('routine');
      await Promise.race([
        approved,
        new Promise<void>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
    }
    return completed;
  });
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    await engine.run();
  } finally {
    clearTimeout(timeout);
  }
  expect(host.answer).toHaveBeenCalledWith(
    task.id,
    'r1',
    'allow',
    'Approved screenshot operation.',
    'secretary',
  );
  expect(store.lastEvent(task.id, 'pm_question')?.data).toEqual({
    message: 'Install the browser tool?',
    kind: 'question',
  });
});

it('lets the PM take over an escalation without replacing an unanswered question', async () => {
  let pmRuns = 0;
  host.run = vi.fn(async (_task, plan) => {
    if (plan.role === 'pm') {
      pmRuns++;
      if (pmRuns === 1) {
        await engine.call('dispatch', {
          plan: DISPATCH_PLAN,
          workspace: 'shared',
          agentId: 'claude',
          model: 'small',
          goal: 'Check',
          acceptance: 'Checked',
          scope: 'greeting',
          access: 'readOnly',
        });
        await engine.call('ask_user', { message: 'Install tool?' });
      } else {
        await expect(engine.call('ask_user', { message: 'Replace original?' })).rejects.toThrow(
          'unanswered',
        );
        await engine.call('permission', {
          requestId: 'r1',
          sessionId: 'worker-session',
          ts: 100,
          behavior: 'deny',
          reason: 'Outside approved scope.',
        });
        controller.abort();
      }
    } else if (plan.role === 'secretary') {
      await rpc(plan, 'escalate_pm', { message: 'Needs PM judgment.' });
    } else {
      pending = [permission];
      engine.notify('routine');
      await new Promise<void>((resolve) =>
        controller.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    }
    return completed;
  });
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    await engine.run();
  } finally {
    clearTimeout(timeout);
  }
  expect(pmRuns).toBe(2);
  expect(host.answer).toHaveBeenCalledWith(task.id, 'r1', 'deny', 'Outside approved scope.');
  expect(store.eventsOfKind(task.id, 'pm_question')).toHaveLength(1);
});

it('lets the PM take over a failed secretary while preserving the unanswered question', async () => {
  let pmRuns = 0;
  host.run = vi.fn(async (_task, plan) => {
    if (plan.role === 'pm') {
      pmRuns++;
      if (pmRuns === 1) {
        await engine.call('dispatch', {
          plan: DISPATCH_PLAN,
          workspace: 'shared',
          agentId: 'claude',
          model: 'small',
          goal: 'Check',
          acceptance: 'Checked',
          scope: 'greeting',
          access: 'readOnly',
        });
        await engine.call('ask_user', { message: 'Install tool?' });
      } else {
        await expect(engine.call('ask_user', { message: 'Replace original?' })).rejects.toThrow(
          'unanswered',
        );
        await engine.call('permission', {
          requestId: 'r1',
          sessionId: 'worker-session',
          ts: 100,
          behavior: 'deny',
          reason: 'Outside approved scope.',
        });
        controller.abort();
      }
    } else if (plan.role === 'secretary') {
      throw new Error('Secretary CLI unavailable');
    } else {
      pending = [permission];
      engine.notify('routine');
      await new Promise<void>((resolve) =>
        controller.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    }
    return completed;
  });
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    await engine.run();
  } finally {
    clearTimeout(timeout);
  }
  expect(pmRuns).toBe(2);
  expect(host.answer).toHaveBeenCalledWith(task.id, 'r1', 'deny', 'Outside approved scope.');
  expect(store.eventsOfKind(task.id, 'pm_question')).toHaveLength(1);
});
