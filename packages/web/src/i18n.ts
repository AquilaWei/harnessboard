// SPDX-License-Identifier: Apache-2.0
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const en = {
  running: '{{n}} / {{max}} running',
  quota5h: '5-hour quota',
  quota7d: '7-day quota',
  quotaPaused: 'Paused until quota resets',
  quotaUnknown: 'Quota: not reported yet',
  resetsAt: 'resets {{time}}',
  newTask: 'New task',
  settings: 'Settings',
  language: 'Language',
  status: {
    backlog: 'Backlog',
    queued: 'Queued',
    running: 'Running',
    waiting_quota: 'Waiting for quota',
    review: 'Review',
    done: 'Done',
    stopped: 'Stopped',
    failed: 'Failed',
  },
  column: { halted: 'Stopped / failed' },
  sessions_one: '{{count}} session',
  sessions_other: '{{count}} sessions',
  context: 'Context',
  contextValue: '{{pct}}% of {{window}}',
  noContext: 'Not started',
  overSoft: 'past soft limit',
  overHard: 'past hard limit',
  thresholds: 'soft {{soft}}% · hard {{hard}}%',
  emptyColumn: 'No tasks',
  invalidMove: 'A {{from}} task cannot move to {{to}}.',
  tabs: { log: 'Log', diff: 'Diff', sessions: 'Sessions', features: 'Features' },
  loop: {
    badge: 'Loop',
    features: 'Features',
    planning: 'Planning features…',
    verified: '{{verified}} / {{total}} features verified',
    verifyFailed: 'last check failed',
    verifyCommand: 'Verify',
    verifyPassed: 'passed',
    verifyFailedDetail: 'failed (exit {{code}})',
    timedOut: 'timed out',
    noFeatures: 'The initializer session has not written a feature list yet.',
    state: 'State',
    id: 'ID',
    description: 'Feature',
    passes: 'marked passing',
    open: 'open',
  },
  actions: {
    queue: 'Queue',
    resume: 'Resume',
    stop: 'Stop',
    done: 'Mark done',
    copyOpen: 'Copy “open in terminal” command',
    copied: 'Copied',
    close: 'Close',
  },
  fields: { repo: 'Repository', branch: 'Branch', worktree: 'Worktree', base: 'Base' },
  noEvents: 'No output yet.',
  noDiff: 'No changes yet.',
  untracked: 'Untracked files',
  sessionTable: {
    id: 'Session',
    started: 'Started',
    reason: 'Ended because',
    context: 'Context',
    active: 'active',
  },
  endReason: {
    completed: 'completed',
    handoff: 'handed off',
    context_hard_limit: 'hit hard limit',
    quota: 'quota',
    stopped: 'stopped',
    error: 'error',
  },
  form: {
    title: 'Title',
    titleHint: 'Optional; defaults to the first line of the prompt',
    prompt: 'What should the agent do?',
    goal: 'What should the finished project do?',
    mode: 'Mode',
    modes: { single: 'Single task', loop: 'Loop (one feature per session)' },
    modeHint:
      'Loop: an initializer plans a feature list, then each session builds one feature and the harness verifies it.',
    verify: 'Verify command',
    verifyHint:
      'Run by the harness after each session, e.g. npm test. Optional if .harnessboard.json sets verifyCommand.',
    repo: 'Repository path',
    repoHint: 'Absolute path to any directory inside a git repository',
    base: 'Base branch',
    baseHint: 'Optional; defaults to the current branch',
    size: 'Task size',
    sizes: { small: 'Small (soft 30%)', medium: 'Medium (soft 40%)', large: 'Large (soft 50%)' },
    soft: 'Soft %',
    hard: 'Hard %',
    custom: 'Override thresholds',
    allow: 'Extra allowed tools',
    allowHint: 'One rule per line, e.g. Bash(npm test)',
    skip: 'Skip all permission checks',
    skipWarn: 'The agent can run any command. Use only in a sandbox.',
    queueNow: 'Queue immediately',
    create: 'Create task',
    cancel: 'Cancel',
  },
  settingsForm: {
    maxConcurrent: 'Tasks running at once',
    quotaPause: 'Pause new sessions at 5-hour quota %',
    defaultSize: 'Default task size',
    save: 'Save',
    saved: 'Saved',
  },
};

const zhTW: typeof en = {
  running: '執行中 {{n}} / {{max}}',
  quota5h: '5 小時額度',
  quota7d: '7 天額度',
  quotaPaused: '額度不足，暫停中',
  quotaUnknown: '額度：尚未回報',
  resetsAt: '{{time}} 重置',
  newTask: '新增任務',
  settings: '設定',
  language: '語言',
  status: {
    backlog: '待辦',
    queued: '排隊中',
    running: '執行中',
    waiting_quota: '等待額度',
    review: '待審核',
    done: '完成',
    stopped: '已停止',
    failed: '失敗',
  },
  column: { halted: '已停止／失敗' },
  sessions_one: '{{count}} 個 session',
  sessions_other: '{{count}} 個 session',
  context: '上下文',
  contextValue: '{{pct}}%／{{window}}',
  noContext: '尚未開始',
  overSoft: '已超過收尾門檻',
  overHard: '已超過強制門檻',
  thresholds: '收尾 {{soft}}% · 強制 {{hard}}%',
  emptyColumn: '沒有任務',
  invalidMove: '「{{from}}」的任務不能移到「{{to}}」。',
  tabs: { log: '紀錄', diff: '變更', sessions: 'Sessions', features: 'Features' },
  loop: {
    badge: 'Loop',
    features: 'Features',
    planning: '正在規劃 feature…',
    verified: '已驗證 {{verified}} / {{total}} 項 feature',
    verifyFailed: '上次驗證失敗',
    verifyCommand: '驗證指令',
    verifyPassed: '通過',
    verifyFailedDetail: '失敗（結束碼 {{code}}）',
    timedOut: '逾時',
    noFeatures: '初始 session 還沒寫出 feature 清單。',
    state: '狀態',
    id: 'ID',
    description: 'Feature',
    passes: '已標記通過',
    open: '未完成',
  },
  actions: {
    queue: '排入執行',
    resume: '繼續',
    stop: '停止',
    done: '標為完成',
    copyOpen: '複製「在終端機開啟」指令',
    copied: '已複製',
    close: '關閉',
  },
  fields: { repo: 'Repository', branch: '分支', worktree: 'Worktree', base: '基準' },
  noEvents: '還沒有輸出。',
  noDiff: '目前沒有變更。',
  untracked: '未追蹤的檔案',
  sessionTable: {
    id: 'Session',
    started: '開始時間',
    reason: '結束原因',
    context: '上下文',
    active: '進行中',
  },
  endReason: {
    completed: '完成',
    handoff: '交接',
    context_hard_limit: '達強制門檻',
    quota: '額度',
    stopped: '停止',
    error: '錯誤',
  },
  form: {
    title: '標題',
    titleHint: '可省略，預設用提示的第一行',
    prompt: '要 agent 做什麼？',
    goal: '完成後的專案要能做什麼？',
    mode: '模式',
    modes: { single: '單一任務', loop: 'Loop（每個 session 做一項 feature）' },
    modeHint:
      'Loop：先由初始 session 規劃 feature 清單，之後每個 session 做一項，並由 harness 驗證。',
    verify: '驗證指令',
    verifyHint:
      '每個 session 結束後由 harness 執行，例如 npm test。若 .harnessboard.json 已設定 verifyCommand 可省略。',
    repo: 'Repository 路徑',
    repoHint: 'git repository 內任一資料夾的絕對路徑',
    base: '基準分支',
    baseHint: '可省略，預設用目前的分支',
    size: '任務大小',
    sizes: { small: '小（收尾 30%）', medium: '中（收尾 40%）', large: '大（收尾 50%）' },
    soft: '收尾 %',
    hard: '強制 %',
    custom: '自訂門檻',
    allow: '額外允許的工具',
    allowHint: '一行一條規則，例如 Bash(npm test)',
    skip: '跳過所有權限檢查',
    skipWarn: 'agent 可以執行任何指令，只能在沙盒環境使用。',
    queueNow: '建立後立即排入執行',
    create: '建立任務',
    cancel: '取消',
  },
  settingsForm: {
    maxConcurrent: '同時執行的任務數',
    quotaPause: '5 小時額度達到幾 % 時暫停新 session',
    defaultSize: '預設任務大小',
    save: '儲存',
    saved: '已儲存',
  },
};

export const LANGUAGES = { en: 'English', 'zh-TW': '繁體中文' } as const;
export type Language = keyof typeof LANGUAGES;
const STORAGE_KEY = 'harnessboard.lang';

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh-TW') return saved;
  } catch {
    // storage unavailable (private mode); fall back to the browser language
  }
  return /^zh-(TW|Hant|HK)/i.test(navigator.language) ? 'zh-TW' : 'en';
}

export function setLanguage(lang: Language): void {
  void i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // not persisted; the choice still applies to this page
  }
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, 'zh-TW': { translation: zhTW } },
  lng: initialLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React escapes already
});
document.documentElement.lang = i18n.language;

export default i18n;
