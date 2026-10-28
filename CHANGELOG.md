# Changelog

## 0.2.13 - 2026-10-28

Local test build. Typecheck, lint and build pass. Full suite: 1949 passed, 1 failed, 14 skipped; the previously recorded nested development branch CLI test still times out. Its sequential CLI fixture competes with secretary/worker execution. Installed RPM 0.2.13 starts successfully; isolated desktop fixtures verify PM answer navigation, concurrent waiting states, hidden raw approvals and API rejection. Live-model routing quality remains unverified. No tag or Release.

### Fixed

- PM 等待使用者回答時，秘書仍以事件喚醒審查 worker 的例行授權與問題；升級或失敗由 PM 接手，保留原本尚未回答的問題。
- PM 任務的底層 CLI 授權只留在內部審查佇列；前端不提供直接批准入口，一般授權 API 也拒絕繞過 PM。一般任務維持既有授權流程。
- 卡片與通知中的 PM 問題直接開啟回答對話，並顯示等待回答時其他已核准工作仍在繼續。
- 使用者回答只交回 PM 判斷；過期或重用 ID 的請求不能以舊 session 與時間戳批准。團隊面板分別顯示等待秘書、PM 決策與使用者回答。

## 0.2.12 - 2026-10-27

Local test build. Secretary regression suite: 28 passed. Full suite: 1938 passed, 1 failed, 14 skipped; the previously observed nested development branch CLI integration test still times out.

### Fixed

- 秘書明確區分本輪訊息與工程師完整任務；正常回覆卻漏呼叫收尾工具時交由 PM 接手，保留待決權限並保持秘書可用，避免誤標失敗。

## 0.2.11 - 2026-10-27

Local test build. Typecheck, lint and new project-bootstrap tests pass. Full suite: 1932 passed, 5 failed, 14 skipped; nested PM branches, chat, designer and quota-pause failures remain under investigation. Live desktop acceptance is pending.

### Added

- 新增 PM 任務可選擇尚無 Git 或 commit 的資料夾；保留既有檔案與暫存內容，由 PM 在規格核准後依 code 規範安排專案初始化。

- PM 可依明確功能、驗收條件與不重疊的修改路徑，從當下提交建立獨立 branch／worktree 平行開發；同一工作續用原對話與分支。
- 完成的分支由父層整合與驗證；越界修改拒絕交付，整合衝突回報檔案並保留主工作區，未整合不得驗收。團隊面板顯示各工作分支與責任路徑。

## 0.2.10 - 2026-10-24

Local test release; live-model filtering quality and token savings still need observation.

### Fixed

- 秘書每批同步取得相關 worker 的初次交辦、工作範圍與驗收條件，以及 PM 後續指示，避免只拿總規格誤判例行工作。
- PM 繼續已完成的 worker 時也會保存交辦內容；權限請求可對應原 worker 與歷史 session，重啟後仍能取得已記錄的指示。
- 秘書可引用 PM 後續指示回答簡單問題；不確定、衝突不清或交付驗收仍交由 PM 親自處理。

## 0.2.9 - 2026-10-24

Local test release; live-model quality and interactive desktop acceptance are pending.

### Added

- worker 執行期間的進度、問題與交付先經秘書過濾；派工時自動委任允許的本機模型，優先選擇名稱標示為輕量的模型。
- 秘書可引用核准指示回答簡單問題；只要不確定、同一問題仍未解決，或需要交付審查，就升交 PM，由 PM 親自與原 worker 溝通。

### Fixed

- 未委任或秘書失敗時明確回退 PM，避免 worker 回報無人處理；PM 自己的進度訊息不再啟動秘書批次。

## 0.2.8 - 2026-10-23

Local test release; interactive desktop acceptance is pending.

### Added

- PM 可從允許的輕量模型中自行委任秘書，處理例行權限、整理進度；重要決策與交付審查才喚醒 PM，秘書用量於團隊面板獨立顯示。
- 秘書每批使用新對話，保留重啟恢復與權限有效性檢查；失敗或額度不足時升交 PM，避免反覆重試。

### Fixed

- 受管理 Codex agent 使用 harnessboard 工具時，由程式直接處理內部確認，避免回報進度或等待也反覆要求 PM 審批。

## 0.2.7 - 2026-10-22

Local test release; interactive desktop acceptance is pending.

### Added

- PM 與本機 Claude／Codex worker 可依需求委派受管理的 subagent，追蹤從屬關係與進度；共用工作目錄的修改接續進行，獨立分析可平行。
- 新增桌面與手機的 Agent 團隊面板，以機器人樹狀關係顯示工作狀態，點選查看模型、token 明細、估算成本與事件紀錄。

### Fixed

- PM 恢復對話時取得實際 worker 狀態，避免將已失敗工作誤認為仍在執行；空等待會被拒絕，補正一次仍無下一步時明確顯示協調失敗。

## 0.2.6 - 2026-10-22

Local test release; interactive desktop acceptance is pending.

### Fixed

- PM 與 Worker 支援尚無第一筆提交的分支，建立 orphan 歷史時不再因讀取 HEAD 而中斷權限核准；第一筆提交仍檢查提交規範。

## 0.2.5 - 2026-10-22

Local test release; interactive desktop acceptance is pending.

### Fixed

- 修正 PM 問答後 Merge 與結案入口消失；執行中保留入口並顯示停用原因，未批准規格禁止合併與結案。
- 驗收報告保留對應提交，HEAD 改變時提示重新驗收。

All notable changes are listed here. Versions follow `MAJOR.MINOR.PATCH`; 0.0.x releases
are test versions that have not been accepted on real machines yet.

## 0.2.4 - 2026-10-20

Local test release; interactive desktop acceptance is pending.

### Fixed

- Allow users to close an idle PM task while it is waiting for confirmation, without another model run.

### Changed

- Simplify PM task details with compact totals and a full-width agent table; collapse
  token/pricing details and remove duplicate model totals, mode and review messages.

## 0.2.3 - 2026-10-20

Local test release; interactive desktop acceptance is pending.

### Fixed

- PM completion now submits its report for user review instead of moving directly to Done.

### Changed

- Remove the legacy handoff tab from PM tasks; keep historical notes for legacy workflows.

- Show PM and delegated agents in a compact table with individual models, status,
  tokens, estimated cost and execution time; collapse full worker instructions.

## 0.2.2 - 2026-10-20

Local test release; interactive model-menu acceptance is pending.

### Added

- Choose permitted worker models from a platform model menu, add multiple models, and
  remove individual entries in new tasks and stopped task PM settings.

## 0.2.1 - 2026-10-20

Test release; real-model and desktop end-to-end acceptance is pending.

### Added

- New tasks use a PM conversation to agree the specification, coordinate permitted
  same-platform or cross-platform workers, decide one-time permissions, and review
  architecture, functionality and verification evidence before completion.
- Reuse PM/worker conversations and send changed specifications and rules instead of
  repeating them. Child summaries are bounded; full evidence remains available.
- Show PM/worker results and usage, configure their model pool, and convert stopped
  legacy tasks while preserving history. Existing tasks retain their original workflow.
- Limit each task to two workers and one writer. Native subagents remain disabled until
  their lifecycle and usage can be tracked. PM currently requires local Claude Code or
  Codex; Gemini and Docker profiles can be workers. Real-model acceptance is pending.

## 0.2.0 - 2026-10-19

### Changed

- Establish the current development workflow as the baseline before introducing PM-led
  task orchestration. This version retains the existing role-based workflow; the PM
  workflow is not included. No local installers were built for this baseline.

## 0.1.31 - 2026-10-18

Local test build; real-device acceptance is pending.

### Added

- The fallback implementer can have its own model and reasoning effort: pick them next to
  the fallback in the New task dialog or the task's agents, or use `--fallback-model` and
  `--fallback-effort` on `hb add`, `hb loop` and `hb models`. Without a choice it uses its
  profile's model and effort, as before.

## 0.1.30 - 2026-10-18

Local test build; real-device acceptance is pending.

### Added

- A task can name a fallback implementer, such as Codex for a Claude task. When the
  implementer's quota reaches its pause level or runs out, the fallback goes on with the
  work in a new session instead of the task waiting for the reset, and the card says who is
  standing in. Once the implementer has quota again, it takes over at the next session.
  When both are out of quota, the task waits until whichever has quota first.
- Set the default for new tasks under **Settings**; change it per task in the New task
  dialog, the task's agents, `--fallback <agent>` on `hb add` / `hb loop`, or
  `hb models <id> --fallback <agent>`.

## 0.1.29 - 2026-10-17

Local test build; real-device acceptance is pending.

### Fixed

- Codex usage on the board is the latest reading. Before, a resumed Codex session that last
  wrote a record without usage could make the board show an hour-old reading, such as 42%
  instead of 97%.
- A Codex task that hits the usage limit waits for the reset of the used-up window. When the
  reading shows neither window used up, it retries at the sooner reset instead of the
  seven-day one, which could leave a task waiting six days instead of two hours.
- Approving a reopened loop plan keeps the verified progress of the features still marked
  as passing. Before, the board showed 0 verified until the tester passed again.

## 0.1.28 - 2026-10-16

Local test build; real-device acceptance is pending.

### Changed

- A merge commit says what the task did: it reuses the task's main commit, such as
  `fix: keep the nearer stop (task #27)`, instead of `chore: merge task #27`. The oldest feat
  commit is used, then fix, perf or refactor; a task with only docs or chore commits keeps
  `chore: merge task #N`.

## 0.1.27 - 2026-10-16

Local test build; real-device acceptance is pending.

### Fixed

- A single task whose acceptance criteria were discussed first can be chatted with once its
  work is done, also after it is merged, and continued with `hb open`. Before, sending a
  message answered "has no conversation to continue yet", because the agent had built the
  task in the same conversation in which it discussed the criteria.
- Merging a task makes a merge commit of one English line, `chore: merge task #N`, without the
  task's title and branch. An agent resolving merge conflicts is given a commit message in the
  same format.

## 0.1.26 - 2026-10-15

Local test build; real-device acceptance is pending.

### Changed

- A tester or reviewer that goes on in its own conversation is no longer told its role rules
  every round (the tester's rule not to change files, the reviewer's focus and test rule), nor
  again not to request the features still to come. They are given in the first round, and
  again after the conversation is compacted.

## 0.1.25 - 2026-10-15

Local test build; real-device acceptance is pending.

### Changed

- Agents that go on in their own conversation are no longer sent the same text every turn.
  The commit rule, the notes instructions and a loop's steps are given once, and again only
  after the conversation is compacted. Resuming after the usage limit sends just the request
  to continue.
- Handoff notes reach each role once: a resumed implementer, tester or reviewer gets only the
  notes written since its last turn, without the notes file's header, and a reviewer's notes
  are no longer repeated inside its list of required changes.
- Follow-up review and test rounds of a loop task describe only the features that are new or
  newly done, and name the rest by id.

### Fixed

- The tester was told to commit its changes while also being told not to change any file. It
  now gets only the instruction not to change files.

## 0.1.24 - 2026-10-15

Local test build; real-device acceptance is pending.

### Added

- Each platform can have its own quota pause level. Settings shows one for Claude and one
  for Codex; in the config file, `quotaPauseByProvider` sets it, e.g. `{ "codex": 0.8 }`.

### Changed

- The New task dialog offers only "Allow other tools, ask only for dangerous ones" for
  tool permissions, and Settings no longer lists the tools every task may use. Tools are
  allowed by default and only dangerous ones ask; saved rules keep working.

### Fixed

- A session kept running after its platform's usage passed the pause level, until the quota
  ran out. It now stops at the pause level and continues in the same conversation after the
  reset.

## 0.1.23 - 2026-10-15

Local test build; real-device acceptance is pending.

### Fixed

- After a restart, a task waiting for Codex quota started at once and was refused, because
  Codex's usage was not read yet. It is now read before any task starts.
- A task refused by Codex for its usage limit retried after 15 minutes instead of at the
  reset time Codex recorded. It now waits for that reset time.

## 0.1.22 - 2026-10-15

Local test build; real-device acceptance is pending.

### Fixed

- A chat sent after switching a task's implementer to another agent went to the old agent's
  conversation with the new agent's model and failed. The new agent now answers it in a new
  conversation that starts from the task, and keeps that conversation for later chats and
  work.

## 0.1.21 - 2026-10-15

Local test build; real-device acceptance is pending.

### Fixed

- The Codex usage on the board showed an old reading while a task's sessions ran. It came
  from the session log with the latest start, but resumed sessions keep writing to the log
  they started in, so it now comes from the log written last.

## 0.1.20 - 2026-10-15

Local test build; real-device acceptance is pending.

### Changed

- The tester no longer writes tests. It runs the implementer's tests and fails a step when
  the suite fails or an acceptance criterion has no test, naming the missing tests for the
  implementer to add. Changing or committing any file, tests included, stops the task.
- Tests the tester or the reviewer would like beyond that are handed to the implementer in
  their notes, and the implementer decides whether to add them. A missing test the work
  needs is still a required change in a review.

## 0.1.19 - 2026-10-15

Local test build; real-device acceptance is pending.

### Fixed

- A tester that adds tests to a test file kept beside the code, such as a Rust
  `src/runtime/tests.rs` module, a Python `test_*.py` file or a Java `FooTest.java` class,
  no longer fails the task for changing more than tests. The tester is also told exactly
  which files count as tests.

## 0.1.18 - 2026-10-14

Local test build; real-device acceptance is pending.

### Fixed

- Conversations are compacted once they pass the compaction threshold again, even when
  the same agent uses models with different context windows (for example a Codex
  implementer and a reviewer on a larger model). Previously the share was measured against
  the other model's window, so compaction and the safety limit could be skipped.

## 0.1.17 - 2026-10-14

Local test build; real-device acceptance is pending.

### Fixed

- Compactable task conversations remain accessible beyond the wrap-up budget, so you can
  ask about blocked development without being incorrectly told the conversation is full.
- Paused loop tasks show their actual verified feature count instead of presenting a
  previous step's approval as completion of the entire project.

### Added

- Task details let you update context wrap-up, hard and compaction thresholds during
  development. Changes apply from the next chat or execution turn; active turns retain
  their original budget.

## 0.1.16 - 2026-10-13

Local test build; real-device acceptance is pending.

### Fixed

- Plan approval descriptions show the task's configured agent instead of always naming Claude.
- Token protection explanations describe usage reporting without naming a specific provider.
- The Traditional Chinese Pending label is now 待執行 throughout the board.
- Completed tasks can continue their original conversation after merging; the worktree is
  recreated from the current base branch when needed. Tasks can still reopen in Draft to
  discuss and approve specification changes.

## 0.1.15 - 2026-10-13

Local test build; real-device acceptance is pending.

### Added

- **Token spike protection:** tasks pause and notify you when reported consumption exceeds
  100,000 tokens within 60 seconds, including cache reads and writes. The global rule is
  adjustable in Settings. Work is preserved; manual resume restarts monitoring. Gemini
  can be checked only at turn end because it does not stream consumption readings.

## 0.1.14 - 2026-10-12

Local test build; real-device acceptance is pending.

### Fixed

- **Plan the spec works again in the desktop app.** For a draft that already has a spec or
  an approved loop plan, the button now asks what should change in its own dialog. Before,
  it did nothing, because the desktop app cannot show the browser's input prompt.

## 0.1.13 - 2026-10-12

Local test build; real-device acceptance is pending.

### Fixed

- **A loop task can reopen its plan from Draft.** After sending a task with an approved plan
  back to Draft, Plan now has the planner revise it and wait for your approval again,
  instead of refusing. Approving again makes the revised feature list the new baseline.
- **Codex sessions report their context size**, so the context limits (such as the 30%
  handoff) apply to Codex tasks too instead of never triggering.

## 0.1.12 - 2026-10-12

Local test build; real-device acceptance is pending.

### Changed

- New tasks automatically discuss their spec in Draft. Confirming the spec places them
  at the end of Pending; prefilled criteria still require confirmation.
- Desktop, mobile, CLI and API now share the same approval requirement. New drafts
  cannot bypass discussion by starting directly or dragging to execution.

## 0.1.11 - 2026-10-10

Local test build for spec-first planning and a reorderable pending queue; real-device acceptance is pending.

### Changed

- **Spec discussions remain available when quota is paused.** Completing a spec puts the task
  in Pending; Harnessboard starts it when quota and a slot are available.
- **Pending tasks follow your order.** Drag cards to reorder them, or use `hb move`; dragging
  a task to In progress still starts it immediately.

## 0.1.10 - 2026-10-10

Local test build for the `hb` start-up fix and the commit trailer fix; real-device acceptance is pending.

### Fixed

- **`hb` works again.** Since 0.1.6 every `hb` command failed at start-up ("cannot add
  command 'plan'") because planning a draft reused the name of `hb plan`. It is now
  `hb discuss <id>`.

- **A commit with a `Co-Authored-By` trailer no longer fails the handoff check.** A task
  whose agent added the attribution line was stopped with "Invalid commit message" even
  though the subject was correct.

### Changed

- **A failed or stopped task can be marked done** (drag it to Done, or `hb done`), for work
  you decided to close without merging.

## 0.1.9 - 2026-10-10

Local test build for the Android crash fix; real-device acceptance is pending.

### Fixed

- **The Android app no longer crashes on launch** when a board is saved: the reachability
  check made its network request on the main thread, which Android forbids.

## 0.1.8 - 2026-10-10

Local test build for starting Tailscale from Phone access; real-device acceptance is pending.

### Changed

- **Settings → Phone access says what is wrong with Tailscale** (not installed, service not
  running, not logged in) and, on Linux, has a **Start Tailscale** button. It starts and
  enables the `tailscaled` service through the system password prompt and shows the login
  address when Tailscale needs one, so no terminal is needed.

## 0.1.7 - 2026-10-10

Local test build for phones that connect on their own; real-device acceptance is pending.

### Changed

- **Paired phones connect as soon as Harnessboard runs.** At start-up, and every five
  minutes until it works, Harnessboard makes the board reachable on your tailnet again when
  a phone is already paired, so nothing needs opening in Settings after a reboot.
- **Pairing a phone is one tap.** The pairing screen suggests the phone's model as its name
  and one **Pair this phone** button pairs it and asks for the passkey, instead of typing a
  name and tapping twice.
- **The Android app connects on its own.** The first launch opens the QR scanner at once
  (no setup screen to get through), a pairing link from the phone's camera sets the board
  up when none is saved, and a board that does not answer shows a clear message with
  **Retry** instead of the browser's error page.

## 0.1.6 - 2026-10-10

Local test build for the pending queue and one-click phone pairing; real-device acceptance is pending.

### Changed

- **Phone access is two things in Settings:** **Pair a phone** (QR code) and the list of
  paired devices. The remote-hosts field, the `tailscale serve` command and the Android app
  block are gone. Pairing now makes the board reachable on your tailnet by itself
  (`tailscale serve --bg`, never Funnel), and this computer's Tailscale name is accepted
  automatically. Hosts already in `config.json` keep working, and `androidAppFingerprints`
  is now set in `config.json` only.

### Added

- A **Pending** column. Plan a draft's spec with **Plan the spec** (`hb discuss`); once you
  approve it, the task waits as pending and the harness starts pending tasks one at a time
  whenever quota is available, so a batch planned ahead is taken up after the quota resets.
- Move tasks by hand between Draft, Pending and Done: drag a card, use the task panel
  buttons, or `hb pend` / `hb draft`. A done task can be reopened in Draft or Pending and
  keeps its history.

## 0.1.5 - 2026-10-10

Local test build for the commit handoff check fix; real-agent acceptance is pending.

### Fixed

- A tester or implementer that rewrites its own commits to fix a message no longer fails
  the task with "rewrote its starting history". The check follows the rewrite and still
  requires every rewritten commit to be valid.

## 0.1.4 - 2026-10-09

Local test build for loop stall protection; real-agent acceptance is pending.

### Fixed

- Loop tasks pause for review after consecutive implementer turns without implementation
  progress, including when passed test/review results or agent sessions are reused.
  Progress counters survive restarts and reset when you send the task back to work.
  Notes and unverified feature flags alone do not count as implementation progress.

## 0.1.3 - 2026-10-09

Local test build for threshold-only automatic compaction; real-agent workflow acceptance
is pending.

### Changed

- Completing a workflow stage no longer triggers automatic compaction by itself.
  Successful turns compact only when current context reaches the configured warning.
  Each role continues using its own session. Without current-context telemetry,
  automatic compaction is not requested.

## 0.1.2 - 2026-10-09

Local test build for persistent role sessions, token savings and commit handoff checks;
real-agent workflow acceptance testing is pending.

### Changed

- Formal stage verification belongs to the configured tester, including loop features;
  Harnessboard no longer duplicates that run. Reviewers focus on architecture, logic and
  code rules without rerunning tests. Only implementers automatically receive new feedback;
  testers and reviewers consult historical notes on demand.
- Writing stages now require a clean worktree and valid single-line English commit messages
  before handoff. Failed checks preserve the work and session and explain what to fix.
- Implementers, reviewers and testers keep their own conversations across features and
  fixes. Follow-up turns receive new handoff notes and changed scope instead of rereading
  the entire notes history. Changed requirements and review rules are still sent again.
- Successful workflow stages compact their conversation even below the warning threshold.
  Other completed turns compact at the configured threshold. Codex uses native thread
  compaction; Claude Code uses `/compact`. Explicitly disabling compaction is respected.

### Fixed

- Saved Codex and Gemini conversations can resume without current-context telemetry.
- Context displays and handoff limits follow the latest role run when sessions are reused.
- Gemini's per-run token reports are added across resumed turns rather than replacing
  earlier usage for the same conversation.

## 0.1.1 - 2026-10-09

Local debug/test build; live Codex cost display still needs acceptance testing.

### Added

- **Codex estimated costs appear in task summaries.** Input, cache and output tokens
  use the resolved model's standard short-context API rates in USD. Older records with
  a known model are estimated when read; recorded costs are preserved and unknown models
  remain unpriced. Subscription plans are not charged per token.

### Fixed

- **Codex cache writes are counted once.** Cache-write tokens are separated from regular
  input so they are not charged twice in the estimate.

## 0.1.0 - 2026-10-09

### Fixed

- **Merge commits follow the commit format.** A merged task's commit is now `chore: merge task #N`
  with the title in its body, instead of copying the title (which could be in any language) into
  the subject.

### Added

- **Choose a reasoning effort next to every model.** Each role of a task (implementer,
  spec author, designer, tester, reviewer) can now think more or less deeply: a **Reasoning
  effort** select sits next to each model picker on the board, and `hb add`, `hb loop` and
  `hb models` take `--effort`, `--spec-effort`, `--designer-effort`, `--tester-effort` and
  `--reviewer-effort`. Only the levels the chosen model offers are listed
  (`hb agents --models <profile>` prints them). Works with Claude Code and Codex; Gemini CLI
  has no such setting. Changing a role's model clears its effort.
- **A default effort per agent profile.** Set it in **Settings → Agents**, with
  `hb agents --add <provider> --effort <level>`, or as `"effort"` in `config.json`. Tasks
  that pick no effort for a role use it. Tested with scripted CLIs; a real Claude and Codex
  run at a chosen effort still needs acceptance testing.

## 0.0.30 - 2026-10-08

### Fixed

- **Codex approval requests reach the board.** Codex now uses app-server instead of
  headless exec, so the Git preset and manual permission answers can approve worktree
  commits without moving the work to a temporary clone. Reviewers remain read-only;
  normal edit tasks keep the sandbox and existing threads resume with the current policy.
  Claude's transport is unchanged. Protocol and Git integration tests pass; a live
  model run still needs acceptance testing.

## 0.0.29 - 2026-10-08

### Fixed

- **Stopped Codex tasks can continue their conversation.** A valid Codex thread was
  previously rejected because Codex does not report its context size. Chat now resumes
  that thread, including messages queued before the task stopped.

## 0.0.28 - 2026-10-08

### Fixed

- **The Fedora/openSUSE `.rpm` installs next to Slack, VS Code and other Electron apps.**
  It used to stop with a file conflict on `/usr/lib/.build-id/...`, so `dnf install` did
  nothing. 0.0.27 was never published; it has the same changes as this version.

## 0.0.27 - 2026-10-08

### Fixed

- **The release build runs through on Windows.** One designer test stopped the agent before
  Windows' slower git had finished its commit, which stopped the release before the
  installers and the Android app were built. It now waits for the commit. 0.0.24 to 0.0.26
  were never released; they have the same changes as this version.

## 0.0.26 - 2026-10-08

### Fixed

- **The release build runs through on Windows.** Four tests expected Windows-style folder
  separators where git prints forward slashes, which stopped the release before the
  installers and the Android app were built. 0.0.24 and 0.0.25 were never released; they
  have the same changes as this version.

## 0.0.25 - 2026-10-08

### Fixed

- **The release build finds the Android app's signing fingerprint again.** Newer Android
  build tools label the signer differently, which stopped the release before it was built.
  0.0.24 was never released; it has the same changes as this version.

## 0.0.24 - 2026-10-08

### Added

- **An Android app for the board.** Install `harnessboard-<version>.apk` from the release,
  scan the pairing QR code from **Settings → Phone access** (or type the board's address),
  and the app opens the same phone board with its own icon, full screen without a URL bar
  once the board knows the app's signing fingerprint.
  Pairing, the passkey, the lock and push notifications work as in Chrome, and a phone
  already paired in Chrome stays paired. Pushes come from the app, and tapping one opens the
  task in the app, even when it was closed. Long-press the icon and pick **Change board** to
  connect it to another board. Needs Android 8.0 or later and Chrome. Not yet tried on a
  real phone.
- **"Android app" in Settings → Phone access**, with the download link and a list of app
  signing fingerprints. Add one when you build the app yourself, so it opens without a
  URL bar too.
- **The release includes the signed APK** and its SHA256, next to the desktop installers.

## 0.0.23 - 2026-10-07

### Changed

- **Less repeated work between roles.** After a review or test round that asks for changes,
  the implementer goes on in its own conversation with only the findings, and a reviewer's
  second round goes on in its own conversation with only what changed since its first,
  instead of each starting over with the whole task. Each falls back to a fresh session when
  the earlier conversation is gone or has no room left.
- **Work in progress is never wrapped up or cut off for the context limit while the session
  is compacted.** The turn finishes and is compacted at the compact level (30 % by default).
  Only 90 % of the window still ends a turn early. With compaction off, nothing changes.

## 0.0.22 - 2026-10-07

### Added

- **Run an agent in a Docker container.** An agent profile with `"sandbox": "docker"` and a
  `"sandboxImage"` runs every session in that image, which sees only the task's folder, its
  git directory and the agent's own login and settings. If docker is missing, the task fails
  and says so instead of running the agent on your computer. Commits made there carry your git
  name and email, the agent gets a writable home of its own for caches, and Gemini reviewers stay read-only whatever Gemini policies the image
  holds. Linux and macOS only; you build the image, environment variables such as API keys
  are not passed in, and the network stays open. Not yet tried with a real agent CLI in a
  container.
- **Gemini as a third agent.** Harnessboard finds the `gemini` command on your PATH and
  offers a profile for it (`hb agents --add gemini`), so Gemini can implement, review, test,
  write the spec or design the UI, next to Claude and Codex. It runs through the signed-in
  Gemini CLI. Reviewers use its `plan` mode with a policy that lets them only read and
  search, even when your Gemini settings allow more; on a machine with Gemini system
  policies, which would override it, a Gemini reviewer is refused. They can not run git, so the harness
  gives a Gemini reviewer the commits and diff it is judging, including a base task's
  earlier stretches of work. Large diffs are saved whole to files the reviewer reads, so
  nothing is cut, and the handoff notes from earlier roles are saved there too. Gemini does not report usage, so the
  header shows no quota for it; a usage-limit error pauses the task and retries it later.
  Not yet tried with the real Gemini CLI.
- **Pair a phone with the board.** Settings has a new "Phone access" section. It finds this
  computer's Tailscale name, saves it as a remote host, and shows the
  `tailscale serve --bg <port>` command to run once. "Pair a phone" shows a QR code; scanning
  it on the phone asks for a device name, then creates a passkey with your fingerprint, face
  or screen lock. The phone is paired only once the passkey is made. The section lists
  paired devices with when each was last used, and Revoke ends a device's access at once.
- **A device that is not paired** sees "This device is not paired" instead of an empty
  board.
- **A paired phone locks itself** each time the board is opened, and after 30 minutes
  without use, and shows an Unlock button that asks for its passkey. This includes a phone
  with the board open while the server restarts; once unlocked, the board updates live again.
  Starting, approving, merging or deleting tasks, and changing settings, agents, tool rules
  or paired devices from a phone need a passkey check within the last 5 minutes; the phone
  asks for it and then carries on with the action. Nothing changes on this computer.
- **Browsers without passkeys**, such as the one inside LINE, say to open the page in Chrome
  or Safari instead of offering to pair or unlock.
- **The board fits a phone screen.** On a narrow screen it shows one list at a time, with
  tabs for Waiting for you, In progress, Review and Done; drafts are under Waiting for you.
  The task panel, New task, Settings and the folder browser fill the screen, and the buttons
  for answering a permission request, a plan or acceptance criteria are big enough to tap.
- **"Files only" on the Changes tab** lists the changed files without the line-by-line
  changes, which is easier to read on a phone.
- **Add the board to a phone's Home Screen.** It gets the Harnessboard icon and opens full
  screen, without the browser's address bar.
- **Push notifications to a paired phone.** Switching on "Notify me when a task needs me" in
  the phone's Settings sends a push whenever a task waits for permission, approval or review,
  or fails, even while the board is closed. Tapping it opens the task on the tab that needs
  you. A push holds only the task's number, title and status. On an iPhone this needs iOS
  16.4 or later and the board added to the Home Screen.
- **Work directly on the base branch.** New task has a choice between "Work on a new branch
  (recommended)" and "Work directly on main" (or whichever branch), and `hb add` / `hb loop`
  have `--on-base`. Such a task works in the repository folder itself, with no worktree or
  branch: its commits land on the branch as it goes and there is nothing to merge after
  review. Only one of them works in a folder at a time. The card shows "on main" and the
  task panel shows where a task works; `hb show` says so too.
- **Change the spec after work has started.** A task with a spec file can have its
  acceptance criteria changed while it is being built or is in review: ask for a change
  (see below), and the spec author proposes revised criteria for you to approve, as for the
  first spec. The implementer can also stop and propose a change itself when it finds the
  spec wrong. Nothing more is built until you decide. Approving
  rewrites the criteria in `docs/specs/<id>-<title>.md`, adds a dated entry under
  "Revisions", commits the file, and the implementer and later reviews work to the new
  criteria. Rejecting leaves the spec as it was and the work carries on.
- **Change the spec from the board or `hb`.** The task panel of a task with a spec has a
  **Change the spec** button, and `hb spec <id> "..."` does the same. A proposed change shows
  the current criteria next to the proposed ones on the Criteria tab, with Approve change,
  Reject change and a reply box; `hb plan <id>` shows both lists with
  the spec author's reply, and `hb reject <id>`
  rejects the change. Cards say when a change waits for you or for the spec author.
- **Optional UI designer.** New task and the task panel's agents have a **Designer** menu
  (None by default), and `hb add` / `hb models` have `--designer`. With a designer, once the
  approved spec is committed it adds a "UI design" section to the spec file before anything
  is built; the implementer follows it and the reviewer checks against it. A designer that
  changes any other file, or adds no such section, stops the task for you. A spec change
  approved or rejected before the design is written still has the designer run before the
  implementer, and on the base branch, commits you or another task made while the designer
  was stopped are not blamed on it. Tasks without a designer work as before.

## 0.0.21 - 2026-10-04

### Added

- **The board shows its version** next to the name in the header, in the browser and in
  the desktop app. With the desktop app attached to an `hb serve`, it is that server's
  version.

### Fixed

- **The app menu shows Harnessboard's icon** after installing the .rpm or .deb. The
  installers only had a 1024 px icon, a size Linux icon themes do not look in.

## 0.0.20 - 2026-10-04

### Added

- **An .rpm installer** for Fedora, openSUSE and other rpm-based distributions: install it
  with `dnf`, and Harnessboard is in the app menu and can be removed like any package. Every
  release now has it next to the .deb and the AppImage. The README gives the build and
  install steps for each OS.

## 0.0.19 - 2026-10-04

### Added

- **Desktop app.** Harnessboard can be built as an app for Linux (AppImage, .deb), macOS
  (.dmg) and Windows (installer): it starts the server itself and shows the board in its own
  window. Closing the window keeps it running in the tray so tasks go on; Quit stops the
  agents cleanly. It uses an `hb serve` that is already running instead of starting another,
  and finds `claude`, `codex` and git the way your terminal does. Builds are not signed yet.
- **Installers on every release.** Each version tag builds the desktop installers on
  Linux, macOS and Windows after the tests pass, and prepares a draft release with them,
  their SHA256 sums and the notes from this changelog.

## 0.0.18 - 2026-10-04

### Added

- **Reviewers follow your coding rules.** List rule files in `reviewGuidelines` (config file
  or the web settings), for example `~/.claude/skills/coding-standards/SKILL.md`. Every review
  quotes them and treats a broken rule as a required change, for Claude and Codex alike.

## 0.0.17 - 2026-10-03

### Changed

- **A task the reviewer stopped shows why.** When a task reaches Review with changes still
  requested, the task panel shows the reviewer's points under the status, and the button
  that sends it back to work reads "Continue with the review".

### Fixed

- **Reviews of a feature list no longer demand the features still to come.** The reviewer of
  a loop task judged each step against the whole goal, so it asked for changes until every
  feature was built and stopped the task after two rounds. It now reviews the features marked
  done, and is told the rest belong to later steps.
- **Sending a task back from review starts the review rounds again.** Before, a task that had
  used its rounds went back to review after one more step, whatever the reviewer said. Now
  the implementer works on the last review's points, and the reviewer and tester get their
  full number of rounds again.

## 0.0.16 - 2026-10-03

### Added

- **Codex usage on the board.** The header shows a quota reading for each platform you use,
  so Codex's 5-hour and 7-day usage appears next to Claude's, and Codex sessions pause near
  the limit like Claude's do. `codex exec` does not report usage, so it is read every minute
  from Codex's own session logs, which include what you used in Codex yourself.

## 0.0.15 - 2026-10-03

### Changed

- **The model menus list what each platform offers**, with names and descriptions: Claude
  Code's own model menu (falling back to `opus`, `sonnet`, `fable` and `haiku`) and Codex's
  model catalog, so Codex models no longer have to be typed. Older models are under **More
  models**; `hb agents --models <profile>` lists them on the command line.
- `hb serve` shows the version it runs, e.g. `Harnessboard v0.0.14 is running at …`.

## 0.0.14 - 2026-10-03

### Added

- **Notes between roles.** Each role ends its reply with a `## Notes` section for the roles
  after it (what it did, its decisions, its doubts, what to check). Harnessboard records them
  and keeps them in `.harnessboard/notes.md` in the task's worktree, which every later role
  reads first; see them on the task's **Notes** tab. Only Harnessboard writes the file: it is
  rebuilt from its own records before each session, so no agent can change another's report,
  and git ignores it.

- **Agent CLIs are found for you.** Harnessboard looks for `claude` and `codex` on your PATH
  and points out any without a profile when the server starts, in `hb agents` and under
  **Settings → Agents**. Add one with the **Add** button or `hb agents --add codex`
  (`--id`, `--model`); it is saved to your config file and can be picked for tasks at once,
  without a restart.

## 0.0.13 - 2026-10-03

### Fixed

- On Windows, writes to system folders (`C:\Windows`, `Program Files`, `ProgramData`) and
  to Unix-style paths such as `/etc` now ask you first, as they do on Linux and macOS.
  Before, these checks never matched on Windows.

## 0.0.12 - 2026-10-03

### Fixed

- CI installs corepack on Windows without colliding with the runner's yarn, and the tests
  pass on macOS, where the temp folder is a symlink.

## 0.0.11 - 2026-10-03

### Fixed

- The CI workflow no longer fails while setting up Node, and it runs only when a version tag
  is pushed.

## 0.0.10 - 2026-10-03

### Added

- **The agreed spec is committed to the repository.** After you approve the criteria, the
  spec author writes the goal, requirements, design (files to change, interfaces, risks),
  out-of-scope items and criteria to `docs/specs/<id>-<title>.md` and commits it, changing
  nothing else (the task stops if it does). Every later agent is told to read that file.
  The discussion now also asks for concrete requirements and a short design, not only
  criteria. Tasks created with criteria and no discussion have no spec file.
- **The implementer keeps the docs in step.** For a task with a spec file, the implementer
  is told to update the README, the changelog entry and any docs the change makes wrong in
  the same work, and the reviewer checks that they are.
- **An optional tester.** Pick a tester (`--tester`, `--tester-model`, the **Tester** menu,
  `hb models --tester`) and each finished step of a single task goes to it before review.
  It writes the missing tests, runs the suite and commits the tests. Failures go back to the
  implementer, and a pass goes on to the reviewer. It may only change test files; if it
  changes anything else the task stops. Tasks without a tester behave as before.
- **A spec author for the acceptance criteria.** The read-only discussion that agrees on
  what "done" means can now be run by its own agent and model (`--spec`, `--spec-model`,
  the **Spec author** menu, `hb models --spec`). It defaults to the implementer, so existing
  tasks behave as before. With a different agent, the implementer starts a new session from
  the approved criteria instead of continuing the discussion.
- **Codex support.** Add a profile with `"provider": "codex"` to `config.json` and pick it
  as a task's implementer or reviewer, so Claude and Codex can check each other's work.
  Codex runs through `codex exec` on your ChatGPT sign-in. It does not report its context
  size, so Harnessboard does not hand off its sessions, and it can not ask about a tool:
  reviewers run in its read-only sandbox, and implementers run unsandboxed when
  auto-approve is on, otherwise in its workspace sandbox, which can edit files but not
  commit.

### Changed

- **Tasks now allow almost everything by default.** Auto-approve is on for new tasks, and
  only dangerous tool uses still ask: wiping the system or home directory, writing to a
  disk, shutting down, writing to system paths (`/etc`, `~/.ssh`...), and deleting
  recursively outside the task's worktree. `git push`, `sudo`, network commands, containers
  and MCP tools no longer ask. A dangerous request can only be allowed once. Use
  `--no-auto-approve` or untick the box to be asked about every tool again. Existing tasks
  keep their setting.

## 0.0.9 - 2026-10-01

### Changed

- A task's models can be changed while it runs or waits for you (**Details → Agents and
  models → Edit**, or `hb models`); they apply from its next session. Its agents still
  change only once it is stopped.

### Fixed

- Allowing or denying a tool while the five-hour usage was over the pause limit let the
  task run on past the limit. The answer is now recorded at once, but the task waits as
  queued and goes on by itself once quota is free again.
- The published package now includes `NOTICE` and the licenses of the packages bundled in
  the web board (`THIRD-PARTY-NOTICES.md`), as their licenses require.

## 0.0.8 - 2026-10-01

### Added

- **Notifications when a task needs you:** turn on **Notify me when a task needs me** under
  Settings. While the board is open in a background tab or a minimised window, the browser
  shows a notification when a task waits for permission, approval or review, or fails;
  clicking it opens the task.

## 0.0.7 - 2026-10-01

### Added

- **Usage per task:** tokens, an estimated cost (at API prices; your subscription is not
  charged per token), agent time and elapsed time, under **Details** and in `hb show`. A
  task in review or done shows them in one line under its status. Tasks from earlier
  versions show "not recorded" for tokens and cost.

## 0.0.6 - 2026-10-01

### Added

- **Chat while a task runs:** a message written while the task is busy waits as _pending_
  and is sent when the current step ends (or as soon as you stop the task); the workflow
  then carries on. Several pending messages are sent together. Cancel them before then with
  **Cancel pending** or `hb chat <id> --cancel`.

## 0.0.5 - 2026-10-01

### Fixed

- The quota popover could show the weekly reset time under the 5-hour window. Each window
  now shows its own reset (the 7-day one with its weekday), and a window that has already
  reset reads as empty.
- New sessions could stay paused after the 5-hour window had reset, while the weekly window
  was the one Claude reported as limiting.
- The button on a card that needs permission said "Allow or deny" although it only opens the
  request; it now says **View request**, and you allow or deny after reading it.

## 0.0.4 - 2026-10-01

### Added

- **Ask less about tools:**
  - **Allow for all tasks** on a permission request (or `hb allow --global`) remembers the
    rule in your settings for every task; edit the list under Settings or with
    `hb global-tools`.
  - **Auto-approve** per task (`--auto-approve`, `hb auto <id> on|off`, or a checkbox)
    allows tools the rules do not cover without asking, but still asks, saying why, about
    risky ones such as `git push`, `rm -r`, `sudo`, network commands and files outside the
    worktree.
- **Answer questions with a click:** when Claude proposes a plan or acceptance criteria,
  each of its questions comes with options you can pick (or write your own answer); your
  picks and notes are sent together as one reply.
- **Merge a task into its base:** `hb merge <id>`, or **Merge into main** on a task in
  review, merges the branch with a merge commit and keeps every commit; the task is then
  done and its worktree and branch are removed. Conflicting changes on the base are sent to
  the task's agent to resolve in its worktree, never in your checkout; review and merge
  again afterwards.

### Changed

- With `HARNESSBOARD_HOME` set, `config.json` is read from and saved to that folder too, so
  a separate instance (for example for testing) no longer changes your own settings.

## 0.0.3 - 2026-09-30

### Added

- **Folder picker in the New task dialog:** browse your folders with git repositories marked,
  and see right away whether a path can be used.
- **Formatted agent replies:** replies, review findings and handoff notes in the timeline,
  and agent text in the log, are rendered as markdown (lists, code, tables). Raw HTML,
  images and unsafe links in agent output are not rendered.

- **Agree on the plan before a Loop builds anything:**
  - The planner proposes features with acceptance criteria, a verify command and open
    questions.
  - The task then waits for you: reply as many times as needed (on the Plan tab or with
    `hb feedback`), then approve with the verify command you confirm (`hb approve`).
  - The verify command is now optional when creating a Loop task.

- **Compacting at a break:** when an implementer's or reviewer's turn ends at 30 % context
  or more, the conversation is compacted with `/compact` before the session closes, never in
  the middle of work. Set the level with `--compact <pct>` or `compactPct` (0 turns it off).
  The context meter shows it as a tick.

- **Chat with a task's agent:** the task panel's Chat tab (and `hb chat <id> <message>`)
  continues the task's own conversation once it has stopped or finished, replacing the
  copy-only "open in terminal" button. The agent remembers the work and may change files
  under the task's tool rules; slash commands such as `/compact` work. The task returns to
  its status when the reply ends, also after a restart.

- **Agree on acceptance criteria first:** a single task created without acceptance
  criteria starts with a read-only discussion. Claude reads the repository and proposes
  criteria with its questions; reply as often as needed, edit them and approve (on the new
  Criteria tab, or with `hb feedback` / `hb approve`). Only then does it start changing
  files, in the same conversation. The implementer and the reviewer both get the approved
  criteria. Give them up front with `--criteria`, or skip the discussion with
  `--no-discuss`.

- **Delete tasks:** from the task panel (with an in-place confirmation) or with
  `hb delete <id>`. The task's history and worktree folder are removed; its branch is kept
  so committed work can still be merged. Running tasks must be stopped first.

- **Models per task:** choose the implementer's and the reviewer's model (Opus, Sonnet,
  Haiku or any model id) when creating a task, and change them later under Details or with
  `hb models <id>`. Without a choice the agent profile's model is used.
- **Commit history:** the Changes tab lists the commits on the task branch since its base;
  open one to see its message and patch. In the terminal: `hb commits <id>`.
- **Asked, not refused:** when the agent wants a tool its rules do not cover, the task
  pauses as "Needs permission" instead of failing the command. Allow it once, allow it and
  add the rule to the task, or deny it with a reason (`hb allow`, `hb deny`).
- **Permission presets:** choose common tool groups (git, node, python, gradle, docker, web,
  files) with `--preset`, and change a task's rules later with `hb tools`.

### Fixed

- A session's context size dropped to 0 after a compaction or a turn that reported no
  usage, so the session could not be resumed afterwards.
- Allowed-tools entries that are not tool rules, such as a sentence describing what is
  allowed, were accepted and silently gave the agent no permissions. They are now rejected.
  `--allow` now adds to the default git rules instead of replacing them.
- Creating a task in a folder outside a git repository showed git's raw error. It now says
  what is wrong and how to fix it. A repository without commits, and paths starting with
  `~`, are handled too.

## 0.0.2 - 2026-09-29

### Added

- **Reviewer role:** `--reviewer <agent>` (or a default reviewer in settings) has a second
  agent check every finished step. A step is a single task or a verified Loop feature.
  - The reviewer runs read-only. Its requested changes go back to the implementer.
  - After 2 rounds, a reply without a verdict, or a reviewer that edits files, the task goes
    to you.
- **Agent profiles:** name several ways to run agents in `config.json`, for example a second
  Claude with another model. `hb agents` lists them and checks that each CLI runs.
- **Redesigned web board:**
  - Four stages instead of seven columns.
  - A one-sentence status and a next-step button on every card.
  - A task panel that leads with what to do, and a timeline of sessions, verification and
    reviews.
  - Light and dark themes.
  - Works at phone width.

### Changed

- `HARNESSBOARD_CLAUDE_PATH` and `HARNESSBOARD_MODEL` now configure the `claude` agent
  profile. The old `claudePath` and `model` config keys are replaced by `agents`.
- Quota is tracked per provider, so a limit on one agent CLI only pauses tasks that use it.

### For contributors

- Agent CLIs plug in through `AgentAdapter` capabilities: prompt on stdin or as an argument,
  and harness- or CLI-assigned session ids. This is groundwork for Codex and Gemini; see
  `docs/architecture.md`.

## 0.0.1 - 2026-09-29

First test version.

### Added

- **Task runner:** each task runs headless `claude` in its own git worktree and branch,
  using your existing Claude Code login. No API key is needed.
- **Context budget:** at a soft threshold (30 / 40 / 50 % of the window for small / medium /
  large tasks), the agent is asked to commit and write a handoff note. The next session then
  starts fresh from that note. At the hard threshold (soft + 10 %) the session ends.
- **Quota awareness:** new sessions pause when 5-hour usage reaches 95 %. A task that hits
  the limit waits and resumes automatically after the reset.
- **Loop mode (`hb loop`):** an initializer session plans a feature list. Each later session
  builds one feature, and Harnessboard runs your verify command itself before counting it.
  The task stops for review when features are removed or progress stalls.
- **`hb` CLI:** `serve`, `add`, `loop`, `ls`, `show`, `logs -f`, `stop`, `resume`, `done`,
  `diff` and `open` (continue a task interactively in Claude Code).
- **Web board** at `http://127.0.0.1:4317`:
  - drag-and-drop status columns
  - context, quota and feature progress meters
  - live log, diff and session history
  - settings
  - English and 繁體中文
- **Local-only API:** only loopback `Host` headers are accepted, and every write needs a
  custom header.

### Known limitations

- Tested on Linux only. Windows and macOS have not been checked on real machines yet.
- Finished worktrees are not merged or removed for you yet.
