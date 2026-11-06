// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CommitInfo,
  HarnessEvent,
  StoredEvent,
  TaskDetail,
  TimelineEntry,
  WorktreeDiff,
} from '@harnessboard/shared';
import { api } from '../api';
import type { TaskAction } from '../board';
import { useLiveEvents, useThrottled } from '../live';
import { canChangeSpec, openReview, sendBackKey } from '../describe';
import { Description } from './Description';
import { Markdown } from './Markdown';
import { ChatPanel } from './ChatPanel';
import { CommitList } from './CommitList';
import { CriteriaReview } from './CriteriaReview';
import { DeleteTask } from './DeleteTask';
import { Details } from './Details';
import { UsageLine } from './UsageSummary';
import { DiffView } from './DiffView';
import { FeatureList } from './FeatureList';
import { NotesView } from './NotesView';
import { FeatureProgress } from './Meter';
import { PermissionPrompt } from './PermissionPrompt';
import { PlanReview } from './PlanReview';
import { AgentTeam } from './AgentTeam';
import { CacheCleanupButton } from './CacheCleanupButton';
import { Timeline } from './Timeline';
import { TaskActionsMenu } from './TaskActionsMenu';
import type { MenuItem } from './TaskActionsMenu';
import '../task-content.css';

export type DrawerTab =
  'team' | 'timeline' | 'notes' | 'chat' | 'criteria' | 'changes' | 'log' | 'features' | 'details';

/** A button in the status box: `primary` is the status's main action, `danger` a stop. */
interface PanelAction extends MenuItem {
  primary?: boolean;
}

interface Props {
  active?: boolean;
  taskId: number;
  initialTab: DrawerTab;
  onAction: (task: TaskDetail, action: TaskAction) => Promise<unknown>;
  onClose: () => void;
  onError: (message: string) => void;
}

/** Task panel: what is happening and what you can do first, then the history and details. */
export function TaskDrawer({
  taskId,
  initialTab,
  onAction,
  onClose,
  onError,
  active = true,
}: Props) {
  const { t } = useTranslation();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [diff, setDiff] = useState<WorktreeDiff | null>(null);
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  // A window opened on the hidden Log tab falls back to the timeline.
  const [tab, setTab] = useState<DrawerTab>(initialTab === 'log' ? 'timeline' : initialTab);
  const lastId = useRef(0);
  const openedTask = useRef<number | null>(null);

  const loadTask = useCallback(
    () =>
      Promise.all([api.task(taskId), api.timeline(taskId)]).then(
        ([detail, steps]) => {
          setTask(detail);
          if (
            detail?.workflow === 'pm' &&
            (initialTab === 'timeline' || initialTab === 'notes') &&
            openedTask.current !== taskId
          )
            setTab('chat');
          openedTask.current = taskId;
          setTimeline(steps);
        },
        (e: Error) => onError(e.message),
      ),
    [taskId, onError, initialTab],
  );

  // Fetches only events after the last one seen, so the log grows in order without gaps.
  const loadEvents = useCallback(async () => {
    let fresh: StoredEvent[];
    try {
      fresh = await api.events(taskId, lastId.current);
    } catch (e) {
      onError((e as Error).message);
      return;
    }
    if (fresh.length === 0) return;
    lastId.current = fresh[fresh.length - 1]!.id;
    setEvents((prev) => [...prev, ...fresh]);
  }, [taskId, onError]);

  useEffect(() => {
    void loadTask();
    void loadEvents();
  }, [loadTask, loadEvents]);

  useEffect(() => {
    if (tab !== 'changes') return;
    api.diff(taskId).then(setDiff, (e: Error) => onError(e.message));
    api.commits(taskId).then(setCommits, (e: Error) => onError(e.message));
  }, [tab, taskId, task?.status, onError]);

  const refresh = useThrottled(() => {
    void loadEvents();
    void loadTask();
  }, 400);
  useLiveEvents((event: HarnessEvent) => {
    if ('taskId' in event && event.taskId === taskId) refresh();
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (active && e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, active]);

  const act = (action: TaskAction) => task && void onAction(task, action).then(loadTask);

  const [merging, setMerging] = useState(false);
  const merge = async () => {
    setMerging(true);
    try {
      const result = await api.mergeTask(taskId);
      // A clean merge shows in the panel itself; conflicts need saying, since work goes on.
      if (result.status === 'conflicts') {
        onError(t('merge.conflicts', { base: result.base, files: result.files.join(', ') }));
      }
      await loadTask();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setMerging(false);
    }
  };

  const s = task?.status;
  const hasCriteria = task?.mode === 'single' && (task.confirmPlan || task.acceptance);
  // The event log is kept for debugging but not offered as a tab.
  const tabs: DrawerTab[] = [
    'timeline',
    ...(task?.workflow === 'pm' ? (['team'] as const) : []),
    ...(task?.mode === 'loop' ? (['features'] as const) : []),
    ...(hasCriteria ? (['criteria'] as const) : []),
    'changes',
    // A chat continues the task's conversation, so there must be one.
    ...(task?.latestSessionId ? (['chat'] as const) : []),
    ...(task?.latestSessionId && task.workflow !== 'pm' ? (['notes'] as const) : []),
    'details',
  ];
  // Where a proposal waiting for approval is read and approved.
  const proposalTab: DrawerTab =
    task?.pmQuestion?.kind === 'question'
      ? 'chat'
      : task?.mode === 'loop'
        ? 'features'
        : 'criteria';
  // Why a task in Review stopped, so it is read before deciding.
  const review = task ? openReview(task) : null;

  // Each status keeps one or two main actions visible; the rest wait in the More menu.
  const mergeOp = task?.operations?.merge.visible ? task.operations.merge : null;
  const completeOp = task?.operations?.complete.visible ? task.operations.complete : null;
  const proposalOpen =
    s === 'awaiting_approval' &&
    (task?.workflow !== 'pm' || task.pmQuestion?.kind === 'spec') &&
    tab !== proposalTab;
  /** The status's own main action; `null` for a status that has none. */
  const statusLead = (detail: TaskDetail): PanelAction | null => {
    switch (detail.status) {
      case 'backlog':
        return {
          key: 'plan',
          label: t('actions.plan'),
          primary: true,
          onSelect: () => act('plan'),
        };
      case 'pending':
        return {
          key: 'start',
          label: t('actions.start'),
          primary: true,
          onSelect: () => act('queue'),
        };
      case 'queued':
      case 'running':
      case 'waiting_quota':
      case 'awaiting_permission':
        return { key: 'stop', label: t('actions.stop'), danger: true, onSelect: () => act('stop') };
      case 'awaiting_approval':
        return proposalOpen
          ? {
              key: 'proposal',
              label: t(detail.mode === 'loop' ? 'actions.approvePlan' : 'actions.approveCriteria'),
              primary: true,
              onSelect: () => setTab(proposalTab),
            }
          : null;
      case 'review':
        return tab === 'changes'
          ? null
          : { key: 'changes', label: t('tabs.changes'), onSelect: () => setTab('changes') };
      case 'failed':
      case 'stopped':
        return {
          key: 'retry',
          label: t('actions.retry'),
          primary: true,
          onSelect: () => act('queue'),
        };
      case 'paused_safety':
        return {
          key: 'resume',
          label: t('actions.resume'),
          primary: true,
          onSelect: () => act('queue'),
        };
      case 'done':
        return {
          key: 'reopen',
          label: t('actions.reopenPending'),
          primary: true,
          onSelect: () => act('pend'),
        };
      default:
        return null;
    }
  };
  const showCache = !!task && task.workspace === 'worktree' && !!task.worktreePath;
  // A running task must be stopped first, so its agent is not left orphaned.
  const showDelete = !!task && !task.activity && s !== 'running' && s !== 'awaiting_permission';
  const main: PanelAction[] = [];
  const more: MenuItem[] = [];
  if (task) {
    if (mergeOp) {
      main.push({
        key: 'merge',
        label: merging ? t('merge.merging') : t('merge.action', { base: task.baseRef }),
        disabled: merging || !mergeOp.enabled,
        title: mergeOp.reason ?? undefined,
        primary: true,
        onSelect: () => void merge(),
      });
    }
    const lead = statusLead(task);
    if (lead) main.push(lead);
    if (completeOp) {
      const complete: MenuItem = {
        key: 'complete',
        label: t(task.branch ? 'actions.markDoneOnly' : 'actions.markDone'),
        disabled: !completeOp.enabled,
        title: completeOp.reason ?? undefined,
        onSelect: () => act('complete'),
      };
      // Mark done is a main action when the status has none of its own, and when a review
      // has no merge to offer, since accepting the work is then the decision.
      if (main.length === 0 || (s === 'review' && !mergeOp))
        main.push({ ...complete, primary: true });
      else more.push(complete);
    }
    if (s === 'review') {
      more.push({
        key: 'sendBack',
        label: t(`actions.${sendBackKey(task)}`),
        onSelect: () => act('queue'),
      });
    }
    if (s === 'pending') {
      more.push({
        key: 'stop',
        label: t('actions.stop'),
        danger: true,
        onSelect: () => act('stop'),
      });
    }
    if (s === 'stopped' || s === 'failed' || s === 'review') {
      more.push({ key: 'pend', label: t('actions.pend'), onSelect: () => act('pend') });
    }
    if (['pending', 'stopped', 'failed', 'review', 'done'].includes(s ?? '')) {
      more.push({
        key: 'draft',
        label: t(s === 'done' ? 'actions.reopenDraft' : 'actions.toDraft'),
        onSelect: () => act('draft'),
      });
    }
    if (canChangeSpec(task) && tab !== 'criteria') {
      more.push({
        key: 'spec',
        label: t('actions.changeSpec'),
        onSelect: () => setTab('criteria'),
      });
    }
  }

  return (
    <>
      <aside className="drawer" role="dialog" aria-modal={false} aria-label={task?.title ?? ''}>
        <div className="drawer-head">
          <div className="drawer-title">
            <details className="task-heading" key={task?.id}>
              <summary>
                <h2>{task?.title}</h2>
              </summary>
            </details>
            <button
              type="button"
              className="btn icon"
              onClick={onClose}
              aria-label={t('actions.close')}
            >
              ✕
            </button>
          </div>
          {task && (
            <div className={`status-box ${s}`}>
              <div className="status-line">
                <span className={`status-chip ${s}`}>
                  <span className={`status-dot ${s}`} aria-hidden /> {t(`status.${task.status}`)}
                </span>
                <span className="card-id">#{task.id}</span>
              </div>
              {/* What needs you comes first; the description says where the task stands. */}
              {task.workflow !== 'pm' && task.permissionRequests.length > 0 && (
                <PermissionPrompt
                  taskId={task.id}
                  requests={task.permissionRequests}
                  onAnswered={() => void loadTask()}
                  onError={onError}
                />
              )}
              {task.pmQuestion && (s === 'running' || s === 'awaiting_approval') && (
                <Markdown className="reply" text={task.pmQuestion.message} />
              )}
              {s === 'review' && task.workflow === 'pm' && task.pmAcceptance && (
                <details className="status-review" open>
                  <summary>{t('pm.accepted')}</summary>
                  <p>
                    <code>{task.pmAcceptance.head}</code>
                  </p>
                  {!task.pmAcceptanceCurrent && <p>{t('pm.reaccept')}</p>}
                  <Markdown
                    className="reply"
                    text={[
                      task.pmAcceptance.summary,
                      task.pmAcceptance.architecture,
                      task.pmAcceptance.functionality,
                      task.pmAcceptance.verification,
                    ].join('\n\n')}
                  />
                </details>
              )}
              {review && (
                <details className="status-review" open>
                  <summary>{t('timeline.reviewFindings', { agent: review.agentId })}</summary>
                  <Markdown className="reply" text={review.findings} />
                </details>
              )}
              <Description task={task} />
              {/* A proposed plan is shown on the Plan tab; progress starts after approval. */}
              {task.mode === 'loop' && task.sessionCount > 0 && !task.plan && (
                <FeatureProgress loop={task.loop} />
              )}
              {(s === 'review' || s === 'done') && <UsageLine usage={task.usage} />}
              <div className="actions">
                {main.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    className={`btn${action.danger ? ' danger' : action.primary ? ' primary' : ''}`}
                    disabled={action.disabled}
                    title={action.title}
                    onClick={action.onSelect}
                  >
                    {action.label}
                  </button>
                ))}
                {mergeOp?.reason && <p className="hint">{mergeOp.reason}</p>}
                {completeOp?.reason && <p className="hint">{completeOp.reason}</p>}
                {task.latestSessionId && tab !== 'chat' && (
                  <button type="button" className="btn ghost" onClick={() => setTab('chat')}>
                    {t('actions.chat')}
                  </button>
                )}
                {(more.length > 0 || showCache || showDelete) && (
                  <TaskActionsMenu items={more}>
                    {showCache && (
                      <CacheCleanupButton key={task.id} taskId={task.id} onError={onError} />
                    )}
                    {/* A running task must be stopped first, so its agent is not left orphaned. */}
                    {showDelete && (
                      <DeleteTask task={task} onDeleted={onClose} onMessage={onError} />
                    )}
                  </TaskActionsMenu>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="tabs" role="tablist">
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {t(`tabs.${id}`)}
            </button>
          ))}
        </div>
        <div className="drawer-body">
          {tab === 'team' && task && <AgentTeam task={task} events={events} />}
          {tab === 'timeline' && <Timeline entries={timeline} />}
          {tab === 'notes' && task && task.workflow !== 'pm' && (
            <NotesView taskId={taskId} version={task.updatedAt} onError={onError} />
          )}
          {tab === 'chat' && task && (
            <ChatPanel task={task} onSent={() => void loadTask()} onError={onError} />
          )}
          {tab === 'criteria' && task && (
            <CriteriaReview task={task} onDone={() => void loadTask()} onError={onError} />
          )}
          {tab === 'features' &&
            task &&
            // Until the plan is approved this tab is where it is discussed and approved.
            (task.plan ? (
              <PlanReview
                task={task}
                version={task.updatedAt}
                onDone={() => void loadTask()}
                onError={onError}
              />
            ) : (
              <FeatureList features={task.features} lastVerify={task.loop?.lastVerify ?? null} />
            ))}
          {tab === 'changes' && (
            <>
              <CommitList taskId={taskId} commits={commits} onError={onError} />
              <h3>{t('commits.allChanges')}</h3>
              <DiffView diff={diff} />
            </>
          )}
          {tab === 'details' && task && (
            <Details task={task} onSaved={() => void loadTask()} onError={onError} />
          )}
        </div>
      </aside>
    </>
  );
}
