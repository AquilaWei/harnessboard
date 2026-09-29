// SPDX-License-Identifier: Apache-2.0
import { ENV_PREFIX } from '@harnessboard/shared';

const en = {
  serverStarted: 'Harnessboard is running at {url} (Ctrl+C to stop)',
  serverUnavailable: 'No Harnessboard server at {url}. Start one with `hb serve`.',
  taskCreated: 'Created task {id} ({status}).',
  noTasks: 'No tasks yet. Add one with `hb add "<prompt>"`.',
  taskNotFound: 'Task {id} not found.',
  taskStatus: 'Task {id} is now {status}.',
  stopRequested: 'Stop requested for task {id}.',
  openWhileRunning: 'Task {id} is running; stop it before opening its session.',
  noSession: 'Task {id} has not started a session yet.',
  opening: 'Opening session {session} in {dir}',
  emptyDiff: 'No changes yet.',
  untracked: 'Untracked files:',
  contextLine: 'context {pct}% of {window} (soft {soft}%, hard {hard}%)',
  agentFound: 'Using {command} {version}',
  agentMissing:
    'Warning: cannot run {command} ({error}). Tasks will fail until it works; set HARNESSBOARD_CLAUDE_PATH if it is installed elsewhere.',
};

type Messages = typeof en;

const zhTW: Messages = {
  serverStarted: 'Harnessboard 已啟動：{url}（按 Ctrl+C 停止）',
  serverUnavailable: '{url} 沒有正在執行的 Harnessboard。請先執行 `hb serve`。',
  taskCreated: '已建立任務 {id}（{status}）。',
  noTasks: '還沒有任務。用 `hb add "<提示>"` 新增。',
  taskNotFound: '找不到任務 {id}。',
  taskStatus: '任務 {id} 目前狀態：{status}。',
  stopRequested: '已要求停止任務 {id}。',
  openWhileRunning: '任務 {id} 正在執行，請先停止再開啟它的 session。',
  noSession: '任務 {id} 還沒有開始任何 session。',
  opening: '在 {dir} 開啟 session {session}',
  emptyDiff: '目前沒有變更。',
  untracked: '未追蹤的檔案：',
  contextLine: '上下文 {pct}%／{window}（收尾 {soft}%，強制 {hard}%）',
  agentFound: '使用 {command} {version}',
  agentMissing:
    '警告：無法執行 {command}（{error}）。修好之前任務都會失敗；如果裝在別的位置，請設定 HARNESSBOARD_CLAUDE_PATH。',
};

function detectLocale(env: NodeJS.ProcessEnv): Messages {
  const lang = env[`${ENV_PREFIX}LANG`] ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? '';
  return /^zh[-_](TW|Hant|HK)/i.test(lang) ? zhTW : en;
}

const messages = detectLocale(process.env);

/** Localised message; `{name}` placeholders are replaced from `vars`. */
export function t(key: keyof Messages, vars: Record<string, string | number> = {}): string {
  return messages[key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(vars[name] ?? `{${name}}`),
  );
}
