// SPDX-License-Identifier: Apache-2.0
// The board's service worker: shows pushes sent to a paired phone and opens the task on a tap.
// It caches nothing, so the board still always loads from the computer. The board registers
// it only when opened remotely (see src/push.ts).
importScripts('/push-notice.js');

self.addEventListener('push', (event) => {
  if (!event.data) return;
  const { title, options } = self.harnessboardPush.pushNotice(
    event.data.json(),
    self.navigator.language,
  );
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { taskId } = event.notification.data;
  event.waitUntil(openTask(taskId));
});

/**
 * An open board is told to open the task rather than reloaded: a reload starts a new board
 * session, which locks the phone. Without an open board, a new one opens on the task.
 */
async function openTask(taskId) {
  const boards = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const board = boards[0];
  if (!board) return self.clients.openWindow(self.harnessboardPush.taskUrl(taskId));
  board.postMessage({ type: 'open-task', taskId });
  return board.focus();
}
