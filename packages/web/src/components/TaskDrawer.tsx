// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  HarnessEvent,
  StoredEvent,
  TaskDetail,
  TimelineEntry,
  WorktreeDiff,
} from '@harnessboard/shared';
import { api } from '../api';
import type { TaskAction } from '../board';
import { useLiveEvents, useThrottled } from '../live';
import { Description } from './Description';
import { Details } from './Details';
import { DiffView } from './DiffView';
import { FeatureList } from './FeatureList';
import { LogView } from './LogView';
import { FeatureProgress } from './Meter';
import { PlanReview } from './PlanReview';
import { Timeline } from './Timeline';

export type DrawerTab = 'timeline' | 'changes' | 'log' | 'features' | 'details';

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
  const [tab, setTab] = useState<DrawerTab>(initialTab);
  const [copied, setCopied] = useState(false);
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
    const fresh = await api.events(taskId, lastId.current);
    if (fresh.length === 0) return;
    lastId.current = fresh[fresh.length - 1]!.id;
    setEvents((prev) => [...prev, ...fresh]);
  }, [taskId]);

  useEffect(() => {
    void loadTask();
    void loadEvents();
  }, [loadTask, loadEvents]);

  useEffect(() => {
    if (tab === 'changes') api.diff(taskId).then(setDiff, (e: Error) => onError(e.message));
  }, [tab, taskId, task?.status, onError]);

  const refresh = useThrottled(() => {
    void loadEvents();
    void loadTask();
  }, 400);
  useLiveEvents((event: HarnessEvent) => {
    if (event.taskId === taskId) refresh();
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const act = (action: TaskAction) => task && void onAction(task, action).then(loadTask);

  const copyOpen = async () => {
    try {
      await navigator.clipboard.writeText(`hb open ${taskId}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      onError(`hb open ${taskId}`);
    }
  };

  const s = task?.status;
  const tabs: DrawerTab[] =
    task?.mode === 'loop'
      ? ['timeline', 'features', 'changes', 'log', 'details']
      : ['timeline', 'changes', 'log', 'details'];

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
              {task.mode === 'loop' && task.sessionCount > 0 && (
                <FeatureProgress loop={task.loop} />
              )}
              <div className="actions">
                {s === 'review' && (
                  <>
                    <button type="button" className="btn primary" onClick={() => act('complete')}>
                      {t('actions.markDone')}
                    </button>
                    {tab !== 'changes' && (
                      <button type="button" className="btn" onClick={() => setTab('changes')}>
                        {t('tabs.changes')}
                      </button>
                    )}
                    <button type="button" className="btn" onClick={() => act('queue')}>
                      {t('actions.sendBack')}
                    </button>
                  </>
                )}
                {s === 'awaiting_approval' && tab !== 'features' && (
                  <button type="button" className="btn primary" onClick={() => setTab('features')}>
                    {t('actions.approvePlan')}
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
                {(s === 'running' || s === 'queued' || s === 'waiting_quota') && (
                  <button type="button" className="btn danger" onClick={() => act('stop')}>
                    {t('actions.stop')}
                  </button>
                )}
                {task.latestSessionId && s !== 'running' && (
                  <button type="button" className="btn ghost" onClick={copyOpen}>
                    {copied ? t('actions.copied') : t('actions.copyOpen')}
                  </button>
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
          {tab === 'changes' && <DiffView diff={diff} />}
          {tab === 'log' && <LogView events={events} window={task?.context?.window ?? 1_000_000} />}
          {tab === 'details' && task && <Details task={task} />}
        </div>
      </aside>
    </>
  );
}
