// SPDX-License-Identifier: Apache-2.0
import { NOTIFY_STATUSES } from '@harnessboard/shared';
import type { TaskStatus, TaskView } from '@harnessboard/shared';
import type { DrawerTab } from './components/TaskDrawer';
import { currentNotifyMode, disablePush, enablePush, forwardedPermissions } from './push';
import type { NotifyMode } from './push';

const STORAGE_KEY = 'harnessboard.notify';

export type WaitingSnapshot = TaskStatus | { status: TaskStatus; forwarded: string[] };

/** Retains live request identities as well as status for the next board refresh. */
export function waitingSnapshot(task: TaskView): WaitingSnapshot {
  return { status: task.status, forwarded: forwardedPermissions(task) };
}

/**
 * Tasks that have just started waiting for you: their status is one of the notifying ones
 * and was different (or the task unknown) at `prev`, or it has a new forwarded request. `prev` is `null` on the first load,
 * which notifies nothing, so opening the board does not replay old waits.
 */
export function newlyWaiting(
  prev: Map<number, WaitingSnapshot> | null,
  tasks: TaskView[],
): TaskView[] {
  if (prev === null) return [];
  return tasks.filter((task) => {
    const previous = prev.get(task.id);
    const status = typeof previous === 'string' ? previous : previous?.status;
    const forwarded = typeof previous === 'object' ? previous.forwarded : [];
    return (
      forwardedPermissions(task).some((id) => !forwarded.includes(id)) ||
      (NOTIFY_STATUSES.has(task.status) && status !== task.status)
    );
  });
}

/** The panel tab that shows what a waiting task needs from you. */
export function openTab(task: TaskView): DrawerTab {
  if (task.permissionRequests?.length) return 'timeline';
  if (task.workflow === 'pm' && task.pmQuestion?.kind === 'question') return 'chat';
  switch (task.status) {
    case 'review':
      return 'changes';
    case 'awaiting_approval':
      return task.mode === 'single' ? 'criteria' : 'features';
    default:
      return 'timeline'; // a permission request is shown above the tabs
  }
}

/** `null` when the browser has no notifications at all. */
export function notificationPermission(): NotificationPermission | null {
  return typeof Notification === 'undefined' ? null : Notification.permission;
}

/** Whether this browser should notify: switched on here and allowed by the browser. */
export function notificationsEnabled(): boolean {
  if (notificationPermission() !== 'granted') return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false; // storage unavailable (private mode)
  }
}

/**
 * Switches notifications on or off for this browser. Switching on asks the browser for
 * permission, so it must run from a click; it returns the permission the browser gave. In
 * `push` mode (a board opened remotely) it also subscribes this device to push, or ends its
 * subscription, and fails when that does; the choice is then left as it was.
 */
export async function setNotifications(
  on: boolean,
  mode: NotifyMode = currentNotifyMode(),
): Promise<NotificationPermission | null> {
  let permission = notificationPermission();
  if (on && permission !== null) permission = await Notification.requestPermission();
  if (mode === 'push') await (on && permission === 'granted' ? enablePush() : disablePush());
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // not persisted; the choice is lost on reload
  }
  return permission;
}

/**
 * Switches notifications off in this browser after it pairs as a new device. The board keeps
 * a push subscription per device, so one saved by an earlier pairing of this browser, since
 * revoked, is gone; leaving the choice "on" would show notifications enabled while no push can
 * arrive. Switching them on again from Settings hands the board the subscription.
 */
export function resetNotifications(): void {
  try {
    localStorage.setItem(STORAGE_KEY, 'off');
  } catch {
    // storage unavailable (private mode); nothing was saved to reset
  }
}
