// SPDX-License-Identifier: Apache-2.0
import type { Session, TaskDetail } from '@harnessboard/shared';
import { t } from './i18n.js';

/**
 * The session and folder `hb open` continues a task in. The interactive agent runs outside
 * the harness, which then cannot keep other agents out of its folder or check the branch
 * checked out there, so a `base` task, which works in the shared repository folder, is
 * refused; `hb chat` runs it through the harness instead.
 * Throws when the task is running, works on the base, or has no implementer session yet.
 */
export function openTarget(
  task: Pick<TaskDetail, 'id' | 'status' | 'workspace' | 'baseRef' | 'worktreePath' | 'sessions'>,
): { session: Session; agentSessionId: string; dir: string } {
  const id = task.id;
  if (task.status === 'running') throw new Error(t('openWhileRunning', { id }));
  if (task.workspace === 'base') throw new Error(t('openBaseTask', { id, base: task.baseRef }));
  // Reviewer sessions are read-only; taking over means continuing the implementer's work.
  const session = task.sessions.findLast((s) => s.role === 'implementer' && s.agentSessionId);
  if (!session?.agentSessionId || !task.worktreePath) throw new Error(t('noSession', { id }));
  return { session, agentSessionId: session.agentSessionId, dir: task.worktreePath };
}
