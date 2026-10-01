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
  taskDeleted: 'Deleted task {id}.',
  noTools: 'No allowed tools; the agent asks before every command.',
  noPermissionRequest: 'Task {id} is not waiting for permission.',
  severalPermissionRequests:
    'Task {id} waits on several requests; choose one with --request (see hb show {id}).',
  permissionWaiting: 'waiting for permission: {tool} {summary} (request {request})',
  taskDeletedBranch:
    'Deleted task {id}. Its branch {branch} is kept; remove it with git branch -D {branch}.',
  openWhileRunning: 'Task {id} is running; stop it before opening its session.',
  noSession: 'Task {id} has not started a session yet.',
  opening: 'Opening session {session} in {dir}',
  emptyDiff: 'No changes yet.',
  untracked: 'Untracked files:',
  contextLine: 'context {pct}% of {window} (soft {soft}%, hard {hard}%)',
  loopLine: 'features {verified}/{total} verified',
  verifyPassed: '(last check `{command}` passed)',
  verifyFailed: '(last check `{command}` failed)',
  agentFound: 'Agent {id}: {command} {version}',
  agentMissing:
    'Warning: agent {id} cannot run {command} ({error}). Its tasks will fail until it works; fix agents.{id}.command in {file} (or HARNESSBOARD_CLAUDE_PATH for claude).',
  unknownAgent: 'Agent profile "{agent}" is not in your config.',
  defaultModel: '(default)',
  suggestedVerify: 'Suggested verify command (not active until you approve): {command}',
  planNext:
    'Reply with `hb feedback {id} "..."`, or start with `hb approve {id} --verify "<command>"`.',
  noVerdict: 'no verdict',
  reviewLine: 'last review by {agent} (round {round}): {verdict}',
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
  taskDeleted: '已刪除任務 {id}。',
  noTools: '沒有允許的工具；agent 每個指令都會先問你。',
  noPermissionRequest: '任務 {id} 沒有在等你允許。',
  severalPermissionRequests: '任務 {id} 有好幾個請求在等，請用 --request 指定（見 hb show {id}）。',
  permissionWaiting: '等你允許：{tool} {summary}（請求 {request}）',
  taskDeletedBranch:
    '已刪除任務 {id}。分支 {branch} 仍保留，不需要的話可以用 git branch -D {branch} 刪除。',
  openWhileRunning: '任務 {id} 正在執行，請先停止再開啟它的 session。',
  noSession: '任務 {id} 還沒有開始任何 session。',
  opening: '在 {dir} 開啟 session {session}',
  emptyDiff: '目前沒有變更。',
  untracked: '未追蹤的檔案：',
  contextLine: '上下文 {pct}%／{window}（收尾 {soft}%，強制 {hard}%）',
  loopLine: 'feature 已驗證 {verified}/{total}',
  verifyPassed: '（上次驗證 `{command}` 通過）',
  verifyFailed: '（上次驗證 `{command}` 失敗）',
  agentFound: 'Agent {id}：{command} {version}',
  agentMissing:
    '警告：agent {id} 無法執行 {command}（{error}）。修好之前它的任務都會失敗；請修改 {file} 裡的 agents.{id}.command（claude 也可以設定 HARNESSBOARD_CLAUDE_PATH）。',
  unknownAgent: '設定檔裡沒有名為「{agent}」的 agent。',
  defaultModel: '（預設）',
  suggestedVerify: '建議的驗證指令（你確認後才生效）：{command}',
  planNext:
    '用 `hb feedback {id} "..."` 回覆意見，或用 `hb approve {id} --verify "<指令>"` 確認開工。',
  noVerdict: '沒有結論',
  reviewLine: '最近一次審查：{agent}（第 {round} 輪）：{verdict}',
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
