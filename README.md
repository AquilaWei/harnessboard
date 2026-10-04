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
- **Quota-aware:** it reads the usage the CLI reports, stops starting sessions near the limit
  (and holds your answer to a tool request until then), and resumes automatically after the
  reset.
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

| Command                                                                               | What it does                                                         |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `hb add <prompt> [--size small\|medium\|large] [--soft N --hard N] [--allow RULE...]` | Create and queue a task                                              |
| `hb loop <goal> [--verify <command>]` [same options as `add`]                         | Start a Loop task (see below)                                        |
| `--criteria <text>` / `--no-discuss` on `add`                                         | Give acceptance criteria, or skip agreeing                           |
| `hb plan <id>` / `hb feedback <id> <text>` / `hb approve <id> [--verify <command>]`   | Review, discuss and approve criteria or plan                         |
| `--reviewer <agent>` on `add` / `loop`                                                | Have another agent review each step (below)                          |
| `--model <m>` / `--reviewer-model <m>` on `add` / `loop`; `hb models <id>`            | Choose models per task; show or change them                          |
| `hb agents`                                                                           | List agent profiles, and agent CLIs found without one                |
| `hb ls` / `hb show <id>`                                                              | List tasks / show sessions, context, tokens, estimated cost and time |
| `hb logs <id> [-f]`                                                                   | Print or follow the log                                              |
| `hb stop <id>` / `hb resume <id>`                                                     | Stop, or queue again                                                 |
| `hb diff <id>` / `hb open <id>` / `hb done <id>`                                      | Review, take over interactively, finish                              |
| `hb chat <id> <message>` / `hb chat <id> --cancel`                                    | Write to the task's agent; drop pending ones                         |
| `hb commits <id>`                                                                     | List the commits on the task branch                                  |
| `hb merge <id>`                                                                       | Merge a reviewed task into its base (below)                          |
| `hb delete <id>`                                                                      | Delete a task that is not running (below)                            |
| `hb allow <id> [--suggested] [--rule RULE...] [--global]` / `hb deny <id> [reason]`   | Answer a tool use the agent waits on                                 |
| `--no-auto-approve` on `add` / `loop`; `hb auto <id> [on\|off]`; `hb global-tools`    | Ask more or less: see Permissions below                              |
| `--preset git,node,...` on `add` / `loop`; `hb tools <id> [RULE...]`                  | Choose allowed tools; show or change them                            |

**Merging a task** (`hb merge`, or **Merge into main** in the task panel of a task in
review) merges its branch into the branch it started from with a merge commit,
`Merge task #N: <title>`, keeping every commit of the task. The task is then done, and its
worktree and branch are removed.

- Your own checkout only changes if it has that branch checked out. It is then
  fast-forwarded to the merge, and git refuses if your local changes would be overwritten.
- If the base branch changed the same lines in the meantime, nothing on it changes. The
  base is merged into the task's worktree instead, and the task's agent resolves the
  conflicts and commits. The task comes back for review (by the reviewer too, if it has
  one); merge again when you are happy with it.
- **Mark done without merging** keeps the old behaviour: the branch stays for you to merge.
- Needs git 2.38 or later.

**Deleting a task** (`hb delete`, or **Delete** in the task panel) removes its history and
its worktree folder, including edits that were not committed. The branch is kept, so
committed work can still be merged; remove it with `git branch -D` when you no longer need
it. Stop a running task first.

## Acceptance criteria: agree first

A task without acceptance criteria does not start changing code right away. Claude first
agrees with you on what "done" means.

```bash
hb add "Add a dark mode toggle"                       # discuss criteria first
hb add "Add a dark mode toggle" --criteria "- toggle persists after reload"   # start now
```

1. **Read-only discussion:** Claude reads the repository without changing anything, then
   proposes acceptance criteria and asks what is unclear. The task waits in _Needs you_.
2. **You decide** on the **Criteria** tab (or with `hb plan <id>`):
   - **reply** (`hb feedback <id> "..."`): Claude answers and revises the criteria in the
     same conversation.
   - **approve** (`hb approve <id>`, or `--criteria "..."` for your own wording): edit the
     criteria if you like, then approve.
3. **The spec is committed:** after you approve, the spec author writes what you agreed
   (goal, requirements, out of scope, your criteria) to `docs/specs/<id>-<title>.md` and
   commits it, changing nothing else. It continues the discussion when it can, so every
   decision makes it into the file. If it leaves the file uncommitted, Harnessboard commits
   it.
4. **Checked against them:** the criteria are saved on the task. Every later agent is told
   to read the spec file, the implementer works towards the criteria, and a reviewer checks
   each one.

The discussion is run by the **spec author**, which is the implementer unless you pick
another agent: `hb add "..." --spec codex --spec-model <model>`, the **Spec author** menu in
the New task dialog, or `hb models <id> --spec <agent>`. With a different agent the
conversation does not carry over: after you approve, the implementer starts a new session
from the approved criteria.

**Tester (optional):** add a **tester** and every finished implementer step goes to it
before review. It writes the tests the step is missing, runs the suite, commits the tests and
answers `TESTS: PASS` or `TESTS: FAIL`. A failure goes back to the implementer (up to the same
two rounds as review, then to you); a pass goes on to the reviewer. It may only change test
files; anything else stops the task. Use `--tester codex --tester-model <model>`, the
**Tester** menu, or `hb models <id> --tester <agent|none>`. It applies to single tasks.

**Notes between roles:** every role ends its reply with a `## Notes` section for the roles
after it: what it did, the decisions it made, what it is unsure of and what to check next.
Harnessboard records each one and keeps them in `.harnessboard/notes.md` in the task's
worktree, oldest first, which the next role is told to read before it starts. Only
Harnessboard writes this file: it is rebuilt from its own records before every session, so
no agent can change another's report, and git ignores it, so it never reaches a commit. Read
it on the task's **Notes** tab. A role that writes no notes section is recorded with its
whole reply. The discussion with you is not part of it; its outcome is the spec file.

When the reviewer asks for changes, the fix goes back through the tester (if there is one)
before the reviewer sees it again.

Criteria given when creating the task are used as they are. `--no-discuss` (or unticking
the box in the New task dialog) starts without criteria.

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

**Models:** each task can pick its own model for the implementer and for the reviewer, for
example Haiku to build and Opus to review: `hb add "..." --model haiku --reviewer claude
--reviewer-model opus`, or the model menus in the New task dialog. Today the reviewer can be
any Claude Code or Codex profile, so different vendors can check each other (Gemini is planned).

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
  - **Changes:** the commits on the task branch (open one for its patch), then the diff against the base branch.
  - **Log:** the live log.
  - **Details:** tokens, estimated cost and time; paths, agents and budget. The cost is the
    CLI's estimate at API prices; a subscription is not charged per token. A task in review or
    done also shows a one-line summary under its status.
  - **Chat:** talk to the agent in the task's own conversation. It remembers the work so
    far and may change files, under the task's tool rules and permission prompts. Slash
    commands such as `/compact` are sent as they are. The task goes back to its status when
    the reply ends.
    - **While the task is busy**, your message waits as _pending_ and is sent when the
      current step ends; the workflow then carries on. Cancel it until then.
    - To work in Claude Code itself, the tab also copies `hb open <id>`.
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
  - **Notify me when a task needs me:** a desktop notification from this browser when a task
    waits for permission, approval or review, or fails, while the board is open but not in
    front. Click it to open the task.

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

**Compacting:** when an agent's turn ends at 30 % or more (the implementer finishing a step,
the reviewer giving its verdict, a chat reply), Harnessboard sends `/compact` before the
session closes. Work is never interrupted for it, and the agent's reply stays the result.
The conversation is then small when it is continued later: in a chat, after a quota pause,
or when work starts after the acceptance criteria were agreed. Change the level with
`--compact <pct>` or `compactPct` in a context policy; `0` turns it off. The soft and hard
thresholds still apply within a turn.

## Configuration

Settings are layered, and later layers win: built-in defaults < user config file <
environment < CLI flags.

- **User config:** `config.json` in the platform config directory (`~/.config/harnessboard` on Linux),
  or in `HARNESSBOARD_HOME` when that is set.
- **Environment:** `HARNESSBOARD_HOME` (data directory and config file), `HARNESSBOARD_PORT`,
  `HARNESSBOARD_MAX_CONCURRENT`, `HARNESSBOARD_LANG` (`en`, `zh-TW`), and
  `HARNESSBOARD_CLAUDE_PATH` / `HARNESSBOARD_MODEL`, which apply to the `claude` agent profile.
- **Per repository:** `.harnessboard.json` with `baseRef`, `allowedTools`, `contextPolicy` and
  `verifyCommand`.

**Agent profiles:** each profile names an agent CLI and how to run it. `claude` always exists.
Harnessboard looks for the `claude` and `codex` commands on your PATH and points out any that
have no profile yet (in `hb serve`'s output, `hb agents` and **Settings → Agents**). Add one
with one click in **Settings**, or:

```bash
hb agents --add codex                  # profile "codex" with the CLI's default model
hb agents --add codex --id fast --model gpt-6-luna
```

Profiles are saved in `config.json`, where you can also write them by hand, for example a
second Claude with another model:

```json
{
  "agents": {
    "claude": { "provider": "claude-code", "command": "claude", "model": null },
    "opus": { "provider": "claude-code", "command": "claude", "model": "opus" },
    "codex": { "provider": "codex", "command": "codex", "model": null }
  }
}
```

Supported providers: `claude-code` and `codex`. A Codex profile uses the signed-in
[Codex CLI](https://github.com/openai/codex) (`codex exec`), so a ChatGPT plan works without
an API key. Codex can not ask about a tool: its sandbox decides, so permission rules and
prompts do not apply to it. The design for adding other CLIs, such as Gemini, is in
[docs/architecture.md](docs/architecture.md).

**Permissions:** tasks run with `--permission-mode acceptEdits` and a list of allowed tool
rules such as `Bash(npm *)`:

- **Presets** are checkboxes in the New task dialog (or `--preset`) and cover common needs: `git` (the default, so the agent can commit), `node`,
  `python`, `gradle`, `docker`, `web` (`WebFetch`, `WebSearch`) and `files`. `docker` is
  nearly unrestricted, because a container can mount any folder.
- Add single rules with `--allow`. Entries that are not tool rules, such as a sentence, are
  rejected instead of being silently ignored.
- **Dangerous things are asked, not refused:** with auto-approve (the default, see below)
  only dangerous tool uses pause the task; with it off, every tool the rules do not
  cover does. The task pauses as **Needs permission** and waits for you. Allow it once, allow it
  and add a rule to the task (the agent's suggestion, e.g. `Bash(node *)`, is filled in), or
  deny it with a reason the agent is told. In the terminal: `hb allow <id> [--suggested]
[--rule RULE...]` and `hb deny <id> [reason]`. A waiting task keeps its slot; reviewers are
  never asked and stay read-only.
- Change a task's rules while it is not running: **Details → Allowed tools → Edit** on the
  board, or `hb tools <id> RULE...`.
- **For every task:** **Allow for all tasks** on a request (or `hb allow <id> --global`)
  adds the rule to `allowedTools` in your user config. Every task's sessions get these rules
  on top of their own. Edit them under **Settings** or with `hb global-tools [RULE...]`.
- **Auto-approve** (on by default; a checkbox when creating a task or under Details,
  `--no-auto-approve`, or `hb auto <id> on|off`): tools the rules do not cover are allowed
  without asking, except dangerous ones, which still ask and say why. Dangerous means
  wiping the system or your home directory (`rm -rf /`, `rm -rf ~`), writing to a disk
  (`mkfs`, `dd of=/dev/...`), shutting the machine down, writing to system paths (`/etc`,
  `/usr`, `~/.ssh`, `~/.claude`...), and deleting recursively outside the task's worktree.
  `git push`, `sudo`, network commands, containers and MCP tools are allowed. A dangerous
  request can only be allowed once; it offers no rule to remember. A list like this cannot
  catch everything, so it is a safety net, not a sandbox. It can be switched while the task
  runs. Tasks created before 0.0.10 keep their old setting.
- `--skip-permissions` removes all checks; use it only in a sandbox.

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
Anthropic. The licenses of the packages bundled in the web board are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
