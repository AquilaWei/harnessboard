// SPDX-License-Identifier: Apache-2.0
import type { Session } from '@harnessboard/shared';
import { describe, expect, it } from 'vitest';
import { openTarget } from '../src/open.js';

const implementer: Session = {
  id: 's1',
  taskId: 1,
  role: 'implementer',
  agentId: 'claude',
  agentSessionId: 'agent-s1',
  startedAt: 0,
  endedAt: 1,
  endReason: 'completed',
  contextTokens: 10_000,
  contextWindow: null,
};

describe('opening a worktree task', () => {
  it('continues its implementer session in its worktree', () => {
    const target = openTarget({
      id: 1,
      status: 'review',
      workspace: 'worktree',
      baseRef: 'main',
      worktreePath: '/data/wt/abc-1',
      sessions: [implementer],
    });
    expect([target.agentSessionId, target.dir]).toEqual(['agent-s1', '/data/wt/abc-1']);
  });
});

describe('opening a base task', () => {
  // Done, so the harness lets another base task (task 2) hold the same folder meanwhile.
  it('is refused while another task may hold the repository folder', () => {
    const open = () =>
      openTarget({
        id: 1,
        status: 'done',
        workspace: 'base',
        baseRef: 'main',
        worktreePath: '/repo',
        sessions: [implementer],
      });
    expect(open).toThrow('hb chat 1'); // the message is localised; the command is not
  });

  // Stopped, so nothing checked which branch the user has checked out in the folder since.
  it('is refused even when the folder may have another branch checked out', () => {
    const open = () =>
      openTarget({
        id: 1,
        status: 'stopped',
        workspace: 'base',
        baseRef: 'main',
        worktreePath: '/repo',
        sessions: [implementer],
      });
    expect(open).toThrow('hb chat 1'); // the message is localised; the command is not
  });
});
