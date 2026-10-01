# Changelog

All notable changes are listed here. Versions follow `MAJOR.MINOR.PATCH`; 0.0.x releases
are test versions that have not been accepted on real machines yet.

## Unreleased

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

- **Delete tasks:** from the task panel (with an in-place confirmation) or with
  `hb delete <id>`. The task's history and worktree folder are removed; its branch is kept
  so committed work can still be merged. Running tasks must be stopped first.

- **Commit history:** the Changes tab lists the commits on the task branch since its base;
  open one to see its message and patch. In the terminal: `hb commits <id>`.
- **Asked, not refused:** when the agent wants a tool its rules do not cover, the task
  pauses as "Needs permission" instead of failing the command. Allow it once, allow it and
  add the rule to the task, or deny it with a reason (`hb allow`, `hb deny`).
- **Permission presets:** choose common tool groups (git, node, python, gradle, docker, web,
  files) with `--preset`, and change a task's rules later with `hb tools`.

### Fixed

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
