// SPDX-License-Identifier: Apache-2.0
// What a push to a paired phone shows, and where tapping it goes. Loaded by sw.js with
// `importScripts`, which takes classic scripts only, so this is plain JavaScript that puts its
// functions on `self` rather than an ES module. test/push-notice.test.ts runs it the same way.
// The board's language setting lives in the page's storage, out of a service worker's reach, so
// the status text follows the phone's language instead.

/** Status words, the same as the board's `status.*` strings. */
const STATUS_TEXT = {
  en: {
    awaiting_permission: 'Needs permission',
    awaiting_approval: 'Waiting for approval',
    review: 'Ready for review',
    failed: 'Failed',
  },
  zhTW: {
    awaiting_permission: '等你允許',
    awaiting_approval: '等你確認',
    review: '待審核',
    failed: '失敗',
  },
};

/**
 * The board address that opens a task. The board reads `#task=<id>` and opens the task on the
 * tab `openTab()` picks, because only the board knows the task's mode, which that tab depends on.
 */
function taskUrl(taskId) {
  return `/#task=${encodeURIComponent(String(taskId))}`;
}

/**
 * The notification for a push's `PushPayload` (`{taskId, title, status}`). `language` is the
 * phone's, e.g. `navigator.language`; anything but Chinese gets English. The tag matches the
 * board's own notifications, so a newer notice for a task replaces the older one.
 */
function pushNotice(payload, language) {
  const words = /^zh/i.test(language) ? STATUS_TEXT.zhTW : STATUS_TEXT.en;
  return {
    title: `#${payload.taskId} ${payload.title}`,
    options: {
      body: words[payload.status] ?? payload.status,
      tag: `task-${payload.taskId}`,
      icon: '/icons/192x192.png',
      data: { taskId: payload.taskId },
    },
  };
}

self.harnessboardPush = { taskUrl, pushNotice };
