# Harnessboard

**English** · [繁體中文](README.zh-TW.md)

**A local harness and task board for running Claude Code agents.** Each task runs headless
`claude` in its own git worktree. Harnessboard keeps every session's context small by handing
work off to a fresh session, and it pauses when your subscription quota runs low.

> **Status: early development (0.0.x).** The runner, the `hb` CLI, the web board and the
> autonomous Loop mode work; Windows and macOS have not been tested on real machines yet.

## Why

- **Small contexts:** at a soft threshold (30–50 % of the window, depending on task size),
  the agent is asked to commit and write a handoff note. The next session then starts fresh
  from that note.
- **Parallel and isolated:** one git worktree and branch per task, so you review a diff
  instead of a mess.
- **Quota-aware:** it reads the usage the CLI reports, stops starting sessions near the limit,
  and resumes automatically after the reset.
- **Uses your existing login:** it drives the `claude` CLI you are already signed in to.
  No API key is needed.

## Requirements

- Node.js ≥ 22.13 (see `.nvmrc`)
- Git
- [Claude Code](https://docs.claude.com/en/docs/claude-code), signed in
- Linux, macOS or Windows (on Windows, Claude Code needs Git for Windows)

## Quick start

```bash
pnpm install && pnpm build           # from a clone; npm package coming later
alias hb="node $PWD/packages/server/dist/cli.js"

hb serve                             # terminal 1: scheduler, API and web board
                                     # → open http://127.0.0.1:4317
cd ~/my-project                      # terminal 2: any git repository
hb add "Fix the flaky date test"     # queue a task (runs in its own worktree)
hb ls                                # status and context % of every task
hb logs 1 -f                         # follow the agent
hb diff 1                            # review what it changed
hb open 1                            # continue the session interactively in Claude Code
hb done 1                            # mark it reviewed
```

| Command                                                                               | What it does                                 |
| ------------------------------------------------------------------------------------- | -------------------------------------------- |
| `hb add <prompt> [--size small\|medium\|large] [--soft N --hard N] [--allow RULE...]` | Create and queue a task                      |
| `hb loop <goal> [--verify <command>]` [same options as `add`]                         | Start a Loop task (see below)                |
| `hb plan <id>` / `hb feedback <id> <text>` / `hb approve <id> --verify <command>`     | Review, discuss and approve a Loop plan      |
| `--reviewer <agent>` on `add` / `loop`                                                | Have another agent review each step (below)  |
| `hb agents`                                                                           | List agent profiles and whether they run     |
| `hb ls` / `hb show <id>`                                                              | List tasks / show sessions and context usage |
| `hb logs <id> [-f]`                                                                   | Print or follow the log                      |
| `hb stop <id>` / `hb resume <id>`                                                     | Stop, or queue again                         |
| `hb diff <id>` / `hb open <id>` / `hb done <id>`                                      | Review, take over interactively, finish      |
| `hb delete <id>`                                                                      | Delete a task that is not running (below)    |

**Deleting a task** (`hb delete`, or **Delete** in the task panel) removes its history and
its worktree folder, including edits that were not committed. The branch is kept, so
committed work can still be merged; remove it with `git branch -D` when you no longer need
it. Stop a running task first.

## Loop mode

For goals too big for one session, `hb loop` works the way Anthropic describes for
long-running agents. Before anything is built, you agree on the plan with Claude.

```bash
hb loop "A CLI calculator with add, subtract, multiply and divide"
```

1. **Planning session:** the agent splits the goal into small features, each with
   acceptance criteria, and writes `feature_list.json` and `progress.md`.
   - It suggests a verify command (for example `npm test`) and lists questions it needs
     you to answer.
   - It implements nothing yet.
2. **You review the plan:** the task waits in _Needs you_. Open its **Plan** tab (or run
   `hb plan <id>`) to read the features, acceptance criteria, questions and suggested
   command. Then either:
   - **reply** (`hb feedback <id> "..."`): the planner revises the plan in the same
     conversation and asks again. Repeat as often as you like. To talk it through live,
     `hb open <id>` opens the same session in Claude Code.
   - **approve** (`hb approve <id> --verify "<command>"`): you confirm or change the verify
     command, and building starts from the plan as it is at that moment.
3. **One feature per session:** every later session starts with a fresh context. It reads
   the progress notes, builds the next open feature to its acceptance criteria, runs the
   verify command, marks the feature as passing and commits.
4. **Harness checks the work itself:** after each session Harnessboard runs the verify
   command in the worktree. A feature counts only when that command succeeds. When it
   fails, the output goes to the next session.
5. **Finish or stop for review:** the task moves to Review when every feature passes and
   verification succeeds. It stops as failed if features are removed from the list, or if
   there is no verified progress for `loopStallSessions` (default 3) sessions in a row.

The verify command always comes from you. The planner's suggestion has no effect until you
approve it, and the agent is allowed to run exactly the approved command. It runs through
your shell (`sh` or `cmd.exe`) with a 10-minute timeout (`verifyTimeoutMinutes`). You can
also set it up front, with `--verify` or `verifyCommand` in `.harnessboard.json`.
`--no-confirm-plan` skips the review and starts building right after planning; it needs a
verify command.

## Reviewer: agents checking each other

Give a task a reviewer, and every finished step is checked by a second agent before the task
moves on. A step is a finished single task, or a verified Loop feature.

```bash
hb add "Add input validation to the signup form" --reviewer opus
```

- **Read-only:** the reviewer runs in the same worktree but can only read files and run
  `git diff`, `git log` and `git show`. If it changes anything anyway, the task stops for
  you.
- **Verdict:** the reviewer answers `VERDICT: APPROVE` or `VERDICT: CHANGES` followed by
  what to fix. Requested changes go to the implementer's next session.
- **Bounded:** after `maxReviewRounds` (2) rounds of requested changes, or a reply without
  a verdict, the task goes to Review for you to decide.
- **Default reviewer:** `defaultReviewer` in the config (or the web settings) applies to
  new tasks. `--reviewer none` turns review off for one task.

Today the reviewer can be any Claude Code profile, for example with a different model.
Codex and Gemini are planned as further providers, so different vendors can check each
other.

## Web board

`hb serve` also serves the board at **http://127.0.0.1:4317**:

- **Four stages that fit one screen:**
  - **Draft**
  - **In progress:** queued, running, or waiting for quota
  - **Needs you:** ready for review, failed, or stopped
  - **Done**

  Each card shows its exact state as a labelled chip.

- **Every card says what is happening** in one sentence, for example "claude is building
  feature 2 of 3", "reviewer is reviewing the latest step", or "Paused for quota; continues
  at 20:40".
- **Every card has one button** for the next step: Start, Stop, Review or Retry. Dragging
  between stages still works and follows the same rules.
- **Task panel:**
  - At the top, the current situation and what you can do about it (for example Mark done
    or Run again).
  - **Timeline:** each session with its role and agent, handoffs, verification results,
    and reviews with their findings.
  - **Changes:** the diff against the base branch.
  - **Log:** the live log.
  - **Details:** paths, agents and budget.
  - It can also copy `hb open <id>`, so you can take over in Claude Code.
- **Picking a repository:** type a path (`~` works) or click Browse… to walk through your
  folders. Git repositories are marked. The field checks what you picked right away: missing
  folder, not a repository (with the command to fix it), or no commits yet.
- **Context meter** while a session runs. It is blue under budget, amber past the wrap-up
  point and red past the limit, with ticks at both. Loop tasks also show verified feature
  progress.
- **Quota:** the header shows the 5-hour usage; click it for both windows and the pause
  level.
- **Settings:**
  - Concurrency, quota pause level, default task size and default reviewer. These are saved
    to your user config file.
  - The agent profiles and whether each CLI runs.
  - Language (English, 繁體中文) and theme (system, light, dark), which apply to this browser
    only.

The API accepts only loopback `Host` headers, and it requires a custom header on every
write. A web page you visit cannot drive your agents through the browser.

## How the context budget works

| Task size          | Soft threshold: ask the agent to commit and write a handoff note | Hard threshold: end the session |
| ------------------ | ---------------------------------------------------------------- | ------------------------------- |
| `small`            | 30 %                                                             | 40 %                            |
| `medium` (default) | 40 %                                                             | 50 %                            |
| `large`            | 50 %                                                             | 60 %                            |

The next session starts fresh with the original task and the handoff note. Percentages are of
the model's context window, which the CLI reports.

## Configuration

Settings are layered, and later layers win: built-in defaults < user config file <
environment < CLI flags.

- **User config:** `config.json` in the platform config directory (`~/.config/harnessboard` on Linux).
- **Environment:** `HARNESSBOARD_HOME` (data directory), `HARNESSBOARD_PORT`,
  `HARNESSBOARD_MAX_CONCURRENT`, `HARNESSBOARD_LANG` (`en`, `zh-TW`), and
  `HARNESSBOARD_CLAUDE_PATH` / `HARNESSBOARD_MODEL`, which apply to the `claude` agent profile.
- **Per repository:** `.harnessboard.json` with `baseRef`, `allowedTools`, `contextPolicy` and
  `verifyCommand`.

**Agent profiles:** each profile names an agent CLI and how to run it. `claude` always exists;
add more in `config.json`, for example a second Claude with another model:

```json
{
  "agents": {
    "claude": { "provider": "claude-code", "command": "claude", "model": null },
    "opus": { "provider": "claude-code", "command": "claude", "model": "opus" }
  }
}
```

Supported providers: `claude-code`. The design for adding other CLIs, such as Codex or
Gemini, is in [docs/architecture.md](docs/architecture.md).

**Permissions:** tasks run with `--permission-mode acceptEdits`, plus a small allow-list of git
commands so the agent can commit. Add more rules with `--allow`. `--skip-permissions` removes
all checks; use it only in a sandbox.

## Development

```bash
corepack enable        # provides the pinned pnpm version
pnpm install
pnpm test              # uses a fake claude CLI; no account needed
pnpm lint && pnpm typecheck
pnpm --filter @harnessboard/web dev   # UI with hot reload; proxies /api to a running `hb serve`
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose changes and
[CHANGELOG.md](CHANGELOG.md) for what changed in each version. Notes on the Claude Code
output format that Harnessboard relies on are in
[docs/stream-json-notes.md](docs/stream-json-notes.md).

## License

[Apache-2.0](LICENSE). Harnessboard is an independent project and is not affiliated with
Anthropic.
