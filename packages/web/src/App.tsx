// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessStatus, Settings, TaskView } from '@harnessboard/shared';
import { api } from './api';
import { stageOf } from './board';
import type { Stage, TaskAction } from './board';
import { Board } from './components/Board';
import { Header } from './components/Header';
import { NewTaskDialog } from './components/NewTaskDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { TaskDrawer } from './components/TaskDrawer';
import type { DrawerTab } from './components/TaskDrawer';
import { useLiveEvents, useThrottled } from './live';

const ACTIONS: Record<TaskAction, (id: number) => Promise<unknown>> = {
  queue: api.queue,
  stop: api.stop,
  complete: api.complete,
};

export function App() {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selected, setSelected] = useState<{ id: number; tab: DrawerTab } | null>(null);
  const [dialog, setDialog] = useState<'new' | 'settings' | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 4000);
  }, []);

  const load = useCallback(async () => {
    try {
      const [nextTasks, nextStatus] = await Promise.all([api.tasks(), api.status()]);
      setTasks(nextTasks);
      setStatus(nextStatus);
    } catch (err) {
      showToast((err as Error).message);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
    api.settings().then(setSettings, (err: Error) => showToast(err.message));
  }, [load, showToast]);

  const refresh = useThrottled(() => void load(), 500);
  useLiveEvents(refresh);

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
