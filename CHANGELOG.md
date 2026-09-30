# Changelog

All notable changes are listed here. Versions follow `MAJOR.MINOR.PATCH`; 0.0.x releases
are test versions that have not been accepted on real machines yet.

## Unreleased

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
