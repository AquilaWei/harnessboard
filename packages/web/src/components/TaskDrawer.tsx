// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessEvent, StoredEvent, TaskDetail, WorktreeDiff } from '@harnessboard/shared';
import { api } from '../api';
import { formatTokens, useLiveEvents, useThrottled } from '../live';
import { DiffView } from './DiffView';
import { LogView } from './LogView';
import { ContextMeter } from './Meter';

type Tab = 'log' | 'diff' | 'sessions';

interface Props {
  taskId: number;
  onClose: () => void;
  onError: (message: string) => void;
}

export function TaskDrawer({ taskId, onClose, onError }: Props) {
  const { t, i18n } = useTranslation();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [diff, setDiff] = useState<WorktreeDiff | null>(null);
  const [tab, setTab] = useState<Tab>('log');
  const [copied, setCopied] = useState(false);
  const lastId = useRef(0);

  const loadTask = useCallback(
    () => api.task(taskId).then(setTask, (e: Error) => onError(e.message)),
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
    lastId.current = 0;
    setEvents([]);
    setDiff(null);
    void loadTask();
    void loadEvents();
  }, [taskId, loadTask, loadEvents]);

  useEffect(() => {
    if (tab === 'diff') api.diff(taskId).then(setDiff, (e: Error) => onError(e.message));
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

  const act = (fn: (id: number) => Promise<unknown>) =>
    fn(taskId).then(loadTask, (e: Error) => onError(e.message));

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
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={task?.title ?? ''}>
        <div className="drawer-head">
          <div className="drawer-title">
            <h2>
              #{taskId} {task?.title}
            </h2>
            <button type="button" className="btn" onClick={onClose} aria-label={t('actions.close')}>
              ✕
            </button>
          </div>
          {task && (
            <>
              <dl className="facts">
                <dt>{t('fields.repo')}</dt>
                <dd className="mono">{task.repoPath}</dd>
                <dt>{t('fields.base')}</dt>
                <dd className="mono">{task.baseRef}</dd>
                <dt>{t('fields.branch')}</dt>
                <dd className="mono">{task.branch ?? '-'}</dd>
                <dt>{t('fields.worktree')}</dt>
                <dd className="mono">{task.worktreePath ?? '-'}</dd>
              </dl>
              {task.sessionCount > 0 && <ContextMeter context={task.context} />}
              <div className="actions">
                <span className="pill">
                  <span className={`status-dot ${task.status}`} aria-hidden />{' '}
                  {t(`status.${task.status}`)}
                </span>
                {(s === 'backlog' || s === 'stopped' || s === 'failed' || s === 'review') && (
                  <button type="button" className="btn primary" onClick={() => act(api.queue)}>
                    {t(s === 'backlog' ? 'actions.queue' : 'actions.resume')}
                  </button>
                )}
                {(s === 'running' || s === 'queued' || s === 'waiting_quota') && (
                  <button type="button" className="btn danger" onClick={() => act(api.stop)}>
                    {t('actions.stop')}
                  </button>
                )}
                {s === 'review' && (
                  <button type="button" className="btn" onClick={() => act(api.complete)}>
                    {t('actions.done')}
                  </button>
                )}
                {task.latestSessionId && s !== 'running' && (
                  <button type="button" className="btn" onClick={copyOpen}>
                    {copied ? t('actions.copied') : t('actions.copyOpen')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <div className="tabs" role="tablist">
          {(['log', 'diff', 'sessions'] as const).map((id) => (
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
          {tab === 'log' && <LogView events={events} window={task?.context?.window ?? 1_000_000} />}
          {tab === 'diff' && <DiffView diff={diff} />}
          {tab === 'sessions' && task && (
            <table>
              <thead>
                <tr>
                  <th>{t('sessionTable.id')}</th>
                  <th>{t('sessionTable.started')}</th>
                  <th>{t('sessionTable.reason')}</th>
                  <th className="num">{t('sessionTable.context')}</th>
                </tr>
              </thead>
              <tbody>
                {task.sessions.map((session) => (
                  <tr key={session.id}>
                    <td className="mono">{session.id.slice(0, 8)}</td>
                    <td>{new Date(session.startedAt).toLocaleString(i18n.language)}</td>
                    <td>
                      {session.endReason
                        ? t(`endReason.${session.endReason}`)
                        : t('sessionTable.active')}
                    </td>
                    <td className="num">{formatTokens(session.contextTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </aside>
    </>
  );
}
