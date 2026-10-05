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
import { openReview, sendBackKey } from '../describe';
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
import { LogView } from './LogView';
import { NotesView } from './NotesView';
import { FeatureProgress } from './Meter';
import { PermissionPrompt } from './PermissionPrompt';
import { PlanReview } from './PlanReview';
import { Timeline } from './Timeline';

export type DrawerTab =
  'timeline' | 'notes' | 'chat' | 'criteria' | 'changes' | 'log' | 'features' | 'details';

interface Props {
  taskId: number;
  initialTab: DrawerTab;
  onAction: (task: TaskDetail, action: TaskAction) => Promise<unknown>;
  onClose: () => void;
  onError: (message: string) => void;
}

/** Task panel: what is happening and what you can do first, then the history and details. */
export function TaskDrawer({ taskId, initialTab, onAction, onClose, onError }: Props) {
  const { t } = useTranslation();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [diff, setDiff] = useState<WorktreeDiff | null>(null);
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [tab, setTab] = useState<DrawerTab>(initialTab);
  const lastId = useRef(0);

  const loadTask = useCallback(
    () =>
      Promise.all([api.task(taskId), api.timeline(taskId)]).then(
        ([detail, steps]) => {
          setTask(detail);
          setTimeline(steps);
        },
        (e: Error) => onError(e.message),
      ),
    [taskId, onError],
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
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
  const tabs: DrawerTab[] = [
    'timeline',
    ...(task?.mode === 'loop' ? (['features'] as const) : []),
    ...(hasCriteria ? (['criteria'] as const) : []),
    ...(task?.latestSessionId ? (['notes'] as const) : []),
    // A chat continues the task's conversation, so there must be one.
    ...(task?.latestSessionId ? (['chat'] as const) : []),
    'changes',
    'log',
    'details',
  ];
  // Where a proposal waiting for approval is read and approved.
  const proposalTab: DrawerTab = task?.mode === 'loop' ? 'features' : 'criteria';
  // Why a task in Review stopped, so it is read before deciding.
  const review = task ? openReview(task) : null;

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={task?.title ?? ''}>
        <div className="drawer-head">
          <div className="drawer-title">
            <h2>{task?.title}</h2>
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
              <Description task={task} />
              {review && (
                <details className="status-review" open>
                  <summary>{t('timeline.reviewFindings', { agent: review.agentId })}</summary>
                  <Markdown className="reply" text={review.findings} />
                </details>
              )}
              {(s === 'review' || s === 'done') && <UsageLine usage={task.usage} />}
              {task.permissionRequests.length > 0 && (
                <PermissionPrompt
                  taskId={task.id}
                  requests={task.permissionRequests}
                  onAnswered={() => void loadTask()}
                  onError={onError}
                />
              )}
              {/* A proposed plan is shown on the Plan tab; progress starts after approval. */}
              {task.mode === 'loop' && task.sessionCount > 0 && !task.plan && (
                <FeatureProgress loop={task.loop} />
              )}
              <div className="actions">
                {s === 'review' && (
                  <>
                    {task.branch && (
                      <button
                        type="button"
                        className="btn primary"
                        disabled={merging}
                        onClick={() => void merge()}
                      >
                        {merging ? t('merge.merging') : t('merge.action', { base: task.baseRef })}
                      </button>
                    )}
                    <button
                      type="button"
                      className={`btn ${task.branch ? '' : 'primary'}`}
                      onClick={() => act('complete')}
                    >
                      {t(task.branch ? 'actions.markDoneOnly' : 'actions.markDone')}
                    </button>
                    {tab !== 'changes' && (
                      <button type="button" className="btn" onClick={() => setTab('changes')}>
                        {t('tabs.changes')}
                      </button>
                    )}
                    <button type="button" className="btn" onClick={() => act('queue')}>
                      {t(`actions.${sendBackKey(task)}`)}
                    </button>
                  </>
                )}
                {s === 'awaiting_approval' && tab !== proposalTab && (
                  <button type="button" className="btn primary" onClick={() => setTab(proposalTab)}>
                    {t(task.mode === 'loop' ? 'actions.approvePlan' : 'actions.approveCriteria')}
                  </button>
                )}
                {s === 'backlog' && (
                  <button type="button" className="btn primary" onClick={() => act('queue')}>
                    {t('actions.start')}
                  </button>
                )}
                {(s === 'failed' || s === 'stopped') && (
                  <button type="button" className="btn primary" onClick={() => act('queue')}>
                    {t('actions.retry')}
                  </button>
                )}
                {(s === 'running' ||
                  s === 'awaiting_permission' ||
                  s === 'queued' ||
                  s === 'waiting_quota') && (
                  <button type="button" className="btn danger" onClick={() => act('stop')}>
                    {t('actions.stop')}
                  </button>
                )}
                {task.latestSessionId && tab !== 'chat' && (
                  <button type="button" className="btn ghost" onClick={() => setTab('chat')}>
                    {t('actions.chat')}
                  </button>
                )}
                {/* A running task must be stopped first, so its agent is not left orphaned. */}
                {!task.activity && s !== 'running' && s !== 'awaiting_permission' && (
                  <DeleteTask task={task} onDeleted={onClose} onMessage={onError} />
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
          {tab === 'timeline' && <Timeline entries={timeline} />}
          {tab === 'notes' && task && (
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
          {tab === 'log' && <LogView events={events} window={task?.context?.window ?? 1_000_000} />}
          {tab === 'details' && task && (
            <Details task={task} onSaved={() => void loadTask()} onError={onError} />
          )}
        </div>
      </aside>
    </>
  );
}
