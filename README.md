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
| `hb loop <goal> --verify <command>` [same options as `add`]                           | Start a Loop task (see below)                |
| `hb ls` / `hb show <id>`                                                              | List tasks / show sessions and context usage |
| `hb logs <id> [-f]`                                                                   | Print or follow the log                      |
| `hb stop <id>` / `hb resume <id>`                                                     | Stop, or queue again                         |
| `hb diff <id>` / `hb open <id>` / `hb done <id>`                                      | Review, take over interactively, finish      |

## Loop mode

For goals too big for one session, `hb loop` works the way Anthropic describes for
long-running agents:

```bash
hb loop "A CLI calculator with add, subtract, multiply and divide" --verify "npm test"
```

1. **Initializer session:** the agent splits the goal into small features, writes
   `feature_list.json` and `progress.md`, and commits them. It implements nothing yet.
2. **One feature per session:** every later session starts with a fresh context. It reads
   the progress notes, builds the next open feature, runs the verify command, marks the
   feature as passing and commits.
3. **Harness checks the work itself:** after each session Harnessboard runs `--verify` in the
   worktree. A feature counts only when that command succeeds. When it fails, the output is
   passed to the next session.
4. **Finish or stop for review:** the task moves to Review when every feature passes and
   verification succeeds. It stops as failed if features are removed from the list, or if
   there is no verified progress for `loopStallSessions` (default 3) sessions in a row.

The verify command is required. It can also be set per repository as `verifyCommand` in
`.harnessboard.json`. The command comes from you, not from the agent, and it runs through
your shell (`sh` or `cmd.exe`) with a 10-minute timeout (`verifyTimeoutMinutes`).
The agent is allowed to run exactly that command.

## Web board

`hb serve` also serves the board at **http://127.0.0.1:4317**:

- **Columns per status:** Backlog, Queued, Running, Waiting for quota, Review, Done, and
  Stopped / failed. Drag a card to queue it, stop it or mark it done. Moves that are not
  real transitions are refused.
- **Context meter on every card:** blue while under budget, amber past the soft threshold,
  red past the hard one. Ticks mark both thresholds.
- **Loop tasks** show verified feature progress on the card, plus a Features tab with each
  feature and the output of the last failed check.
- **Quota meters** for the 5-hour and 7-day windows, with the pause threshold marked.
- **Task panel:** live log, diff against the base branch, session history, and buttons
  for resume, stop and done. It also copies the `hb open <id>` command, so you can take
  over in Claude Code.
- **Settings:** concurrency, quota pause level and default task size. Saved to your user
  config file.
- **Languages:** English and 繁體中文; it follows the browser language and can be switched
  in the header.

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
