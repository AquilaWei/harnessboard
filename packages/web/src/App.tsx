// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessStatus, Settings, TaskStatus, TaskView } from '@harnessboard/shared';
import {
  api,
  isLocked,
  isNotPaired,
  isReauthRefused,
  onLocked,
  onNotPaired,
  setReauthPrompt,
} from './api';
import { attentionTab, stageOf } from './board';
import type { PhoneTab, Stage, TaskAction } from './board';
import { Board } from './components/Board';
import { Header } from './components/Header';
import { NewTaskDialog } from './components/NewTaskDialog';
import { NotPaired, PairScreen, UnlockScreen } from './components/PairScreen';
import { SettingsDialog } from './components/SettingsDialog';
import { TaskDrawer } from './components/TaskDrawer';
import type { DrawerTab } from './components/TaskDrawer';
import { descriptionText } from './components/Description';
import { useLiveEvents, useThrottled } from './live';
import { newlyWaiting, notificationsEnabled, openTab } from './notify';
import { checkPasskey, passkeysAvailable } from './passkey';
import { pairCodeFromHash } from './phone';
import { currentNotifyMode, taskFromHash, taskFromMessage } from './push';

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
  const [phoneTab, setPhoneTab] = useState<PhoneTab>('waiting');
  const [toast, setToast] = useState<string | null>(null);
  // A phone opened the pairing address the computer showed as a QR code.
  const [pairCode, setPairCode] = useState(() => pairCodeFromHash(window.location.hash));
  const [notPaired, setNotPaired] = useState(false);
  const [locked, setLocked] = useState(false);
  // Any call can get the 401, including those made by panels and dialogs that only show
  // the error text: a device revoked or locked while its board is open must not keep the board.
  useEffect(() => onNotPaired(() => setNotPaired(true)), []);
  useEffect(() => onLocked(() => setLocked(true)), []);
  // A refused prompt is not reported here: the action then fails with its own 401.
  useEffect(() => {
    setReauthPrompt(() =>
      checkPasskey().then(
        () => true,
        () => false,
      ),
    );
    return () => setReauthPrompt(null);
  }, []);

  // The code works once; keep it out of the address bar and the history. A browser without
  // passkeys keeps it, so "open in browser" carries the code to one that can pair.
  useEffect(() => {
    if (pairCode && passkeysAvailable())
      history.replaceState(null, '', location.pathname + location.search);
  }, [pairCode]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 4000);
  }, []);
  /**
   * Reports a failed call. A 401 for not paired or locked needs no message, the listeners
   * above already swapped the screen.
   */
  const showError = useCallback(
    (err: Error) => {
      // `i18n.t`, not `t`: `t` changes with the language, which would reload the whole board.
      if (isReauthRefused(err)) showToast(i18n.t('phone.reauthCancelled'));
      else if (!isNotPaired(err) && !isLocked(err)) showToast(err.message);
    },
    [showToast, i18n],
  );

  // Statuses at the previous load; `null` until the first one, which notifies nothing.
  const lastStatuses = useRef<Map<number, TaskStatus> | null>(null);
  const notifyWaiting = useRef((_: TaskView[]) => {});
  notifyWaiting.current = (nextTasks: TaskView[]) => {
    const waiting = newlyWaiting(lastStatuses.current, nextTasks);
    lastStatuses.current = new Map(nextTasks.map((task) => [task.id, task.status]));
    // While you are looking at the board the card itself tells you.
    const looking = document.visibilityState === 'visible' && document.hasFocus();
    // A board opened remotely is notified by push instead, which also reaches a closed board.
    if (looking || !notificationsEnabled() || currentNotifyMode() !== 'browser') return;
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

  // A tapped push asks for its task (public/sw.js): a new board by `#task=<id>`, an open one by
  // a message. It is opened by the next load that gets the tasks, which for a locked phone is
  // the one after unlocking, because the tab to open depends on the task.
  const pendingTask = useRef(taskFromHash(window.location.hash));
  const openPendingTask = (nextTasks: TaskView[]) => {
    const task = nextTasks.find((candidate) => candidate.id === pendingTask.current);
    pendingTask.current = null;
    if (task) setSelected({ id: task.id, tab: openTab(task) });
  };
  useEffect(() => {
    if (taskFromHash(location.hash) !== null)
      history.replaceState(null, '', location.pathname + location.search);
  }, []);

  const load = useCallback(async () => {
    try {
      const [nextTasks, nextStatus] = await Promise.all([api.tasks(), api.status()]);
      setTasks(nextTasks);
      if (pendingTask.current !== null) openPendingTask(nextTasks);
      notifyWaiting.current(nextTasks);
      setStatus(nextStatus);
    } catch (err) {
      showError(err as Error);
    }
  }, [showError]);

  /** Loads everything the board shows, at start and again once a phone may use the board. */
  const loadAll = useCallback(() => {
    void load();
    api.settings().then(setSettings, showError);
    // Only shown in the header; the board works without it, so a failure is not reported.
    api.version().then(
      (info) => setVersion(info.version),
      () => setVersion(null),
    );
  }, [load, showError]);

  useEffect(loadAll, [loadAll]);

  useEffect(() => {
    const worker = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
    if (!worker) return;
    const onMessage = (event: MessageEvent) => {
      const id = taskFromMessage(event.data);
      if (id === null) return;
      pendingTask.current = id;
      void load();
    };
    worker.addEventListener('message', onMessage);
    return () => worker.removeEventListener('message', onMessage);
  }, [load]);

  const refresh = useThrottled(() => void load(), 500);
  useLiveEvents((event) => {
    // Deleted elsewhere (e.g. `hb delete`): close its panel, which could no longer load.
    if (event.type === 'deleted') setSelected((s) => (s?.id === event.taskId ? null : s));
    refresh();
  });

  const act = useCallback(
    (task: TaskView, action: TaskAction) => ACTIONS[action](task.id).then(load, showError),
    [load, showError],
  );

  const invalidMove = (task: TaskView, target: Stage) =>
    showToast(t('invalidMove', { from: t(`status.${task.status}`), to: t(`stage.${target}`) }));

  const attention = tasks.filter((task) => stageOf(task.status) === 'attention').length;
  const running = tasks.filter((task) => task.status === 'running').length;

  // No page reload after pairing or unlocking: the session token lives in page memory only.
  // The calls made before then got 401s, so their screens are cleared and the board reloaded.
  const unlocked = () => {
    setNotPaired(false);
    setLocked(false);
    loadAll();
  };
  const jumpToAttention = () => {
    // At phone width the stages are tabs, and Needs you is split into Waiting for you and Review.
    setPhoneTab(attentionTab(tasks));
    document.getElementById('stage-attention')?.scrollIntoView({ behavior: 'smooth' });
  };

  if (pairCode)
    return (
      <PairScreen
        code={pairCode}
        onPaired={() => {
          setPairCode(null);
          unlocked();
        }}
      />
    );
  if (notPaired) return <NotPaired />;
  if (locked) return <UnlockScreen onUnlocked={unlocked} />;

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
        onAttention={jumpToAttention}
      />
      <Board
        tasks={tasks}
        phoneTab={phoneTab}
        onPhoneTab={setPhoneTab}
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
