// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessStatus, Settings, TaskView } from '@harnessboard/shared';
import { api } from './api';
import type { ColumnId, MoveAction } from './board';
import { Board } from './components/Board';
import { Header } from './components/Header';
import { NewTaskDialog } from './components/NewTaskDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { TaskDrawer } from './components/TaskDrawer';
import { useLiveEvents, useThrottled } from './live';

const MOVE: Record<MoveAction, (id: number) => Promise<unknown>> = {
  queue: api.queue,
  stop: api.stop,
  complete: api.complete,
};

export function App() {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
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

  const move = (task: TaskView, action: MoveAction) =>
    MOVE[action](task.id).then(load, (err: Error) => showToast(err.message));

  const invalidMove = (task: TaskView, target: ColumnId) =>
    showToast(
      t('invalidMove', {
        from: t(`status.${task.status}`),
        to: target === 'halted' ? t('column.halted') : t(`status.${target}`),
      }),
    );

  return (
    <>
      <Header
        status={status}
        settings={settings}
        onNewTask={() => setDialog('new')}
        onSettings={() => setDialog('settings')}
      />
      <Board tasks={tasks} onOpen={setSelected} onMove={move} onInvalidMove={invalidMove} />
      {selected !== null && (
        <TaskDrawer taskId={selected} onClose={() => setSelected(null)} onError={showToast} />
      )}
      {dialog === 'new' && (
        <NewTaskDialog
          defaultSize={settings?.defaultContextPolicy.size ?? 'medium'}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setDialog(null);
            void load();
            setSelected(id);
          }}
        />
      )}
      {dialog === 'settings' && settings && (
        <SettingsDialog
          settings={settings}
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
