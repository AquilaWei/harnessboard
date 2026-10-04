// SPDX-License-Identifier: Apache-2.0
import { ENV_PREFIX } from '@harnessboard/shared';

const en = {
  serverStarted: 'Harnessboard {version} is running at {url} (Ctrl+C to stop)',
  serverUnavailable: 'No Harnessboard server at {url}. Start one with `hb serve`.',
  taskCreated: 'Created task {id} ({status}).',
  noTasks: 'No tasks yet. Add one with `hb add "<prompt>"`.',
  taskNotFound: 'Task {id} not found.',
  taskStatus: 'Task {id} is now {status}.',
  stopRequested: 'Stop requested for task {id}.',
  taskDeleted: 'Deleted task {id}.',
  noTools: 'No allowed tools; the agent asks before every command.',
  noCommits: 'Task {id} has no commits yet.',
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
  contextLine: 'context {pct}% of {window} (compact {compact}%, soft {soft}%, hard {hard}%)',
  usageTokens:
    'usage: {total} tokens (in {input}, out {output}, cache read {cacheRead}, cache write {cacheWrite})',
  usageCost: '~{cost} at API prices',
  usageTime: 'agent {agent}, elapsed {elapsed}, runs: {runs}',
  usageNone: 'usage: not recorded',
  loopLine: 'features {verified}/{total} verified',
  verifyPassed: '(last check `{command}` passed)',
  verifyFailed: '(last check `{command}` failed)',
  agentFound: 'Agent {id}: {command} {version}',
  agentMissing:
    'Warning: agent {id} cannot run {command} ({error}). Its tasks will fail until it works; fix agents.{id}.command in {file} (or HARNESSBOARD_CLAUDE_PATH for claude).',
  unknownAgent: 'Agent profile "{agent}" is not in your config.',
  agentDetected:
    'Found {command} {version} with no profile. Add it with `hb agents --add {provider}`.',
  agentNotDetected: 'No {provider} CLI ({command}) found on PATH.',
  agentAdded: 'Added agent profile {id} ({provider}, {command}) to {file}.',
  defaultModel: '(default)',
  sameAsImplementer: '(the implementer)',
  suggestedVerify: 'Suggested verify command (not active until you approve): {command}',
  planNext:
    'Reply with `hb feedback {id} "..."`, or start with `hb approve {id} --verify "<command>"`.',
  criteriaNext:
    'Reply with `hb feedback {id} "..."`, or start with `hb approve {id}` (`--criteria "..."` to approve your own).',
  noCriteria: 'Task {id} has no acceptance criteria.',
  autoOn: 'Task {id} allows unlisted tools without asking; dangerous ones still ask.',
  autoOff: 'Task {id} asks before every tool its rules do not allow.',
  chatEnded: '(the reply ended: {reason})',
  chatQueued:
    'Task {id} is busy; your message will be sent when its current step ends. Cancel it with `hb chat {id} --cancel`.',
  chatCancelled: 'The pending messages of task {id} were dropped.',
  chatNoMessage: 'Write a message, or use --cancel to drop the pending ones.',
  merged: 'Task {id} merged into {base} ({commit}); its worktree and branch were removed.',
  mergeConflicts:
    'Task {id} conflicts with {base}. Its agent is resolving these files; review and merge again afterwards:',
  chatCompacted: '(context compacted: {preTokens} → {postTokens} tokens)',
  criteriaHeading: 'acceptance criteria:',
  noVerdict: 'no verdict',
  reviewLine: 'last review by {agent} (round {round}): {verdict}',
};

type Messages = typeof en;

const zhTW: Messages = {
  serverStarted: 'Harnessboard {version} 已啟動：{url}（按 Ctrl+C 停止）',
  serverUnavailable: '{url} 沒有正在執行的 Harnessboard。請先執行 `hb serve`。',
  taskCreated: '已建立任務 {id}（{status}）。',
  noTasks: '還沒有任務。用 `hb add "<提示>"` 新增。',
  taskNotFound: '找不到任務 {id}。',
  taskStatus: '任務 {id} 目前狀態：{status}。',
  stopRequested: '已要求停止任務 {id}。',
  taskDeleted: '已刪除任務 {id}。',
  noTools: '沒有允許的工具；agent 每個指令都會先問你。',
  noCommits: '任務 {id} 還沒有任何 commit。',
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
  contextLine: '上下文 {pct}%／{window}（壓縮 {compact}%，收尾 {soft}%，強制 {hard}%）',
  usageTokens:
    '用量：{total} tokens（輸入 {input}、輸出 {output}、快取讀 {cacheRead}、快取寫 {cacheWrite}）',
  usageCost: '約 {cost}（API 價格估算）',
  usageTime: 'agent {agent}，總歷時 {elapsed}，執行 {runs} 次',
  usageNone: '用量：未記錄',
  loopLine: 'feature 已驗證 {verified}/{total}',
  verifyPassed: '（上次驗證 `{command}` 通過）',
  verifyFailed: '（上次驗證 `{command}` 失敗）',
  agentFound: 'Agent {id}：{command} {version}',
  agentMissing:
    '警告：agent {id} 無法執行 {command}（{error}）。修好之前它的任務都會失敗；請修改 {file} 裡的 agents.{id}.command（claude 也可以設定 HARNESSBOARD_CLAUDE_PATH）。',
  unknownAgent: '設定檔裡沒有名為「{agent}」的 agent。',
  agentDetected:
    '找到 {command} {version}，但還沒有 profile。用 `hb agents --add {provider}` 加入。',
  agentNotDetected: 'PATH 上找不到 {provider} 的 CLI（{command}）。',
  agentAdded: '已將 agent profile {id}（{provider}，{command}）加入 {file}。',
  defaultModel: '（預設）',
  sameAsImplementer: '（執行者）',
  suggestedVerify: '建議的驗證指令（你確認後才生效）：{command}',
  planNext:
    '用 `hb feedback {id} "..."` 回覆意見，或用 `hb approve {id} --verify "<指令>"` 確認開工。',
  criteriaNext:
    '用 `hb feedback {id} "..."` 回覆意見，或用 `hb approve {id}` 確認開工（加 `--criteria "..."` 改用你自己寫的標準）。',
  noCriteria: '任務 {id} 沒有驗收標準。',
  autoOn: '任務 {id} 會自動允許規則外的工具；危險的仍會詢問。',
  autoOff: '任務 {id} 遇到規則外的工具都會先詢問。',
  chatEnded: '（回覆中斷：{reason}）',
  chatQueued:
    '任務 {id} 正在忙，訊息會在目前這個階段結束後送出。要取消請用 `hb chat {id} --cancel`。',
  chatCancelled: '任務 {id} 待送出的訊息已取消。',
  chatNoMessage: '請寫下訊息，或用 --cancel 取消待送出的訊息。',
  merged: '任務 {id} 已合併到 {base}（{commit}），它的 worktree 和分支已移除。',
  mergeConflicts: '任務 {id} 和 {base} 有衝突。agent 正在解決以下檔案，完成並審核後再合併一次：',
  chatCompacted: '（上下文已壓縮：{preTokens} → {postTokens} tokens）',
  criteriaHeading: '驗收標準：',
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
