# Changelog

All notable changes are listed here. Versions follow `MAJOR.MINOR.PATCH`; 0.0.x releases
are test versions that have not been accepted on real machines yet.

## Unreleased

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
