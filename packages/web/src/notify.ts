// SPDX-License-Identifier: Apache-2.0
import { NOTIFY_STATUSES } from '@harnessboard/shared';
import type { TaskStatus, TaskView } from '@harnessboard/shared';
import type { DrawerTab } from './components/TaskDrawer';

const STORAGE_KEY = 'harnessboard.notify';

/**
 * Tasks that have just started waiting for you: their status is one of the notifying ones
 * and was different (or the task unknown) at `prev`. `prev` is `null` on the first load,
 * which notifies nothing, so opening the board does not replay old waits.
 */
export function newlyWaiting(prev: Map<number, TaskStatus> | null, tasks: TaskView[]): TaskView[] {
  if (prev === null) return [];
  return tasks.filter(
    (task) => NOTIFY_STATUSES.has(task.status) && prev.get(task.id) !== task.status,
  );
}

/** The panel tab that shows what a waiting task needs from you. */
export function openTab(task: TaskView): DrawerTab {
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
 * permission, so it must run from a click; it returns the permission the browser gave.
 */
export async function setNotifications(on: boolean): Promise<NotificationPermission | null> {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    // not persisted; the choice is lost on reload
  }
  if (!on || notificationPermission() === null) return notificationPermission();
  return Notification.requestPermission();
}
