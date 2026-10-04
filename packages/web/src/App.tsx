// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessStatus, Settings, TaskStatus, TaskView } from '@harnessboard/shared';
import { api } from './api';
import { stageOf } from './board';
import type { Stage, TaskAction } from './board';
import { Board } from './components/Board';
import { Header } from './components/Header';
import { NewTaskDialog } from './components/NewTaskDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { TaskDrawer } from './components/TaskDrawer';
import type { DrawerTab } from './components/TaskDrawer';
import { descriptionText } from './components/Description';
import { useLiveEvents, useThrottled } from './live';
import { newlyWaiting, notificationsEnabled, openTab } from './notify';

const ACTIONS: Record<TaskAction, (id: number) => Promise<unknown>> = {
  queue: api.queue,
  stop: api.stop,
  complete: api.complete,
};

export function App() {
  const { t, i18n } = useTranslation();
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ id: number; tab: DrawerTab } | null>(null);
  const [dialog, setDialog] = useState<'new' | 'settings' | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 4000);
  }, []);

  // Statuses at the previous load; `null` until the first one, which notifies nothing.
  const lastStatuses = useRef<Map<number, TaskStatus> | null>(null);
  const notifyWaiting = useRef((_: TaskView[]) => {});
  notifyWaiting.current = (nextTasks: TaskView[]) => {
    const waiting = newlyWaiting(lastStatuses.current, nextTasks);
    lastStatuses.current = new Map(nextTasks.map((task) => [task.id, task.status]));
    // While you are looking at the board the card itself tells you.
    const looking = document.visibilityState === 'visible' && document.hasFocus();
    if (looking || !notificationsEnabled()) return;
    for (const task of waiting) {
      const notification = new Notification(`#${task.id} ${task.title}`, {
        body: descriptionText(task, t, i18n.language),
        tag: `task-${task.id}`, // a newer notice for the task replaces the older one
      });
      notification.onclick = () => {
        window.focus();
        setSelected({ id: task.id, tab: openTab(task) });
        notification.close();
      };
    }
  };

  const load = useCallback(async () => {
    try {
      const [nextTasks, nextStatus] = await Promise.all([api.tasks(), api.status()]);
      setTasks(nextTasks);
      notifyWaiting.current(nextTasks);
      setStatus(nextStatus);
    } catch (err) {
      showToast((err as Error).message);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
    api.settings().then(setSettings, (err: Error) => showToast(err.message));
    // Only shown in the header; the board works without it, so a failure is not reported.
    api.version().then(
      (info) => setVersion(info.version),
      () => setVersion(null),
    );
  }, [load, showToast]);

  const refresh = useThrottled(() => void load(), 500);
  useLiveEvents((event) => {
    // Deleted elsewhere (e.g. `hb delete`): close its panel, which could no longer load.
    if (event.type === 'deleted') setSelected((s) => (s?.id === event.taskId ? null : s));
    refresh();
  });

  const act = useCallback(
    (task: TaskView, action: TaskAction) =>
      ACTIONS[action](task.id).then(load, (err: Error) => showToast(err.message)),
    [load, showToast],
  );

  const invalidMove = (task: TaskView, target: Stage) =>
    showToast(t('invalidMove', { from: t(`status.${task.status}`), to: t(`stage.${target}`) }));

  const attention = tasks.filter((task) => stageOf(task.status) === 'attention').length;
  const running = tasks.filter((task) => task.status === 'running').length;

  return (
    <>
      <Header
        running={running}
        attention={attention}
        status={status}
        settings={settings}
        version={version}
        onNewTask={() => setDialog('new')}
        onSettings={() => setDialog('settings')}
      />
      <Board
        tasks={tasks}
        onOpen={(id, tab = 'timeline') => setSelected({ id, tab })}
        onAction={act}
        onInvalidMove={invalidMove}
        onNewTask={() => setDialog('new')}
      />
      {selected && (
        <TaskDrawer
          key={`${selected.id}-${selected.tab}`}
          taskId={selected.id}
          initialTab={selected.tab}
          onAction={act}
          onClose={() => setSelected(null)}
          onError={showToast}
        />
      )}
      {dialog === 'new' && settings && (
        <NewTaskDialog
          settings={settings}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setDialog(null);
            void load();
            setSelected({ id, tab: 'timeline' });
          }}
        />
      )}
      {dialog === 'settings' && settings && (
        <SettingsDialog
          settings={settings}
          configFile={status?.configFile ?? null}
          onClose={() => setDialog(null)}
          onSaved={(next) => {
            setSettings(next);
            setDialog(null);
            showToast(t('settingsForm.saved'));
            void load();
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}
