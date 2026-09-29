# Harnessboard

**A local harness and task board for running Claude Code agents.** Each task runs headless
`claude` in its own git worktree. Harnessboard keeps every session's context small by handing
work off to a fresh session, and it pauses when your subscription quota runs low.

> **Status: early development (0.0.x).** The runner and the `hb` CLI work; the web UI and
> the autonomous Loop mode are next.

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

hb serve                             # terminal 1: scheduler + local API on 127.0.0.1:4317
cd ~/my-project                      # terminal 2: any git repository
hb add "Fix the flaky date test"     # queue a task (runs in its own worktree)
hb ls                                # status and context % of every task
hb logs 1 -f                         # follow the agent
hb diff 1                            # review what it changed
hb open 1                            # continue the session interactively in Claude Code
hb done 1                            # mark it reviewed
```

| Command | What it does |
|---|---|
| `hb add <prompt> [--size small\|medium\|large] [--soft N --hard N] [--allow RULE...]` | Create and queue a task |
| `hb ls` / `hb show <id>` | List tasks / show sessions and context usage |
| `hb logs <id> [-f]` | Print or follow the log |
| `hb stop <id>` / `hb resume <id>` | Stop, or queue again |
| `hb diff <id>` / `hb open <id>` / `hb done <id>` | Review, take over interactively, finish |

## How the context budget works

| Task size | Soft threshold: ask the agent to commit and write a handoff note | Hard threshold: end the session |
|---|---|---|
| `small` | 30 % | 40 % |
| `medium` (default) | 40 % | 50 % |
| `large` | 50 % | 60 % |

The next session starts fresh with the original task and the handoff note. Percentages are of
the model's context window, which the CLI reports.

## Configuration

Settings are layered, and later layers win: built-in defaults < user config file <
environment < CLI flags.

- **User config:** `config.json` in the platform config directory (`~/.config/harnessboard` on Linux).
- **Environment:** `HARNESSBOARD_HOME` (data directory), `HARNESSBOARD_PORT`, `HARNESSBOARD_CLAUDE_PATH`,
  `HARNESSBOARD_MODEL`, `HARNESSBOARD_MAX_CONCURRENT`, `HARNESSBOARD_LANG` (`en`, `zh-TW`).
- **Per repository:** `.harnessboard.json` with `baseRef`, `allowedTools` and `contextPolicy`.

**Permissions:** tasks run with `--permission-mode acceptEdits`, plus a small allow-list of git
commands so the agent can commit. Add more rules with `--allow`. `--skip-permissions` removes
all checks; use it only in a sandbox.

## Development

```bash
corepack enable        # provides the pinned pnpm version
pnpm install
pnpm test              # uses a fake claude CLI; no account needed
pnpm lint && pnpm typecheck
```

Notes on the Claude Code output format that Harnessboard relies on are in
[docs/stream-json-notes.md](docs/stream-json-notes.md).

## License

[Apache-2.0](LICENSE). Harnessboard is an independent project and is not affiliated with
Anthropic.
