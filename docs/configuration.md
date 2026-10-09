# Configuration

Context budget, config files, agent profiles, permissions and the Docker sandbox.

## Context budget

| Task size          | Soft threshold: ask the agent to commit and write a handoff note | Hard threshold: end the session |
| ------------------ | ---------------------------------------------------------------- | ------------------------------- |
| `small`            | 30 %                                                             | 40 %                            |
| `medium` (default) | 40 %                                                             | 50 %                            |
| `large`            | 50 %                                                             | 60 %                            |

The next session starts fresh with the original task and the handoff note. Percentages are of
the model's context window, which the CLI reports.

**Compacting:** successful turns (planning, implementation, testing, review or chat)
compact only when they finish at or above `compactPct` (30 % by default).
Completing a workflow stage below the warning does not trigger compaction.
Work is never interrupted just to compact, and the agent's reply stays the result.
Each implementer, tester and reviewer continues its own session across stages and fixes;
compaction preserves the session ID. Claude Code uses `/compact`; Codex uses its native
`thread/compact/start` RPC and waits for the compaction turn to finish. Gemini currently
manages its own context; Harnessboard cannot request its compaction through the headless
adapter. Codex's cumulative usage is not treated as current context size, so threshold
compaction requires current-context telemetry. Without that telemetry, automatic
compaction is not requested.
Change the warning level with `--compact <pct>` or `compactPct` in a context policy;
`0` disables automatic compaction. While compaction is
on, the soft and hard thresholds do not act within a turn: the agent is not asked to wrap up
and is not cut off; compaction runs after the turn if the warning has been reached. Only a context at 90 % or more
ends a turn early, so a runaway turn can not overflow the window. With compaction off, or for
an agent that can not be compacted, the soft and hard thresholds apply within the turn.
Emergency context handoffs and unavailable conversations can still require a fresh session.

## Usage estimates

Codex task summaries estimate USD using a bundled price table checked on October 9, 2026
against [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) and the
linked model pages. The table covers GPT-6.1 Sol, GPT-6 Sol/Astra/Luna, GPT-5.6
Sol/Terra/Luna, GPT-5.5, GPT-5/5.1/5.2/5.3 Codex and `codex-mini-latest`.
Prices are standard short-context rates; estimates exclude long-context premiums,
Fast/Ultrafast processing, regional surcharges and separate tool fees. The price table is
updated with the application, without fetching prices during a task.

Input, cached input, cache writes and output are counted separately. Output already
includes reasoning tokens. Models before GPT-5.6 use the regular input rate for cache
writes. Subscriptions are not charged per token.

New runs store the resolved model and estimate. Historical records with a known model,
token counts and no model cost are estimated when read, without rewriting the database;
recorded model costs are preserved. Records named only `codex` and unknown models stay
unpriced. A task containing unpriced models totals only its known costs; unpriced rows
remain blank. Resumed conversations use the latest cumulative report rather than adding
each report again.

## Config files, agents and permissions

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
Harnessboard looks for the `claude`, `codex` and `gemini` commands on your PATH and points out any that
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
    "codex": { "provider": "codex", "command": "codex", "model": null },
    "gemini": { "provider": "gemini", "command": "gemini", "model": null }
  }
}
```

**Reasoning effort:** a profile may also set `"effort"`, how deeply its model reasons by
default. It is one of the level ids its CLI lists (`hb agents --models <profile>`), for
example `low`, `medium`, `high`, `xhigh` or `max` for Claude Code:

```json
{
  "agents": {
    "deep": { "provider": "claude-code", "command": "claude", "model": "opus", "effort": "high" },
    "codex": { "provider": "codex", "command": "codex", "model": null, "effort": "medium" }
  }
}
```

- **Who honours it:** Claude Code (passed as `--effort`) and Codex (the turn's `effort`).
  Gemini CLI has no such option, so a Gemini profile's effort is ignored and no effort is
  offered for it.
- **Which effort a session gets:** the effort chosen for that role on the task, else the
  profile's `"effort"`, else none, leaving it to the CLI. The profile's effort applies whatever
  model the task picks, so a level that model does not offer is still sent; the CLI may then
  refuse or ignore it.
- **Setting it:** `hb agents --add <provider> --effort <level>`, the **Reasoning effort**
  column in **Settings → Agents**, or by hand. Loading the config fails on a value that is not
  a single word, naming `config agents.<id>.effort`. Remove the key (or pick **Default** in
  Settings) to leave it to the CLI.

Supported providers: `claude-code`, `codex` and `gemini`. A Codex profile uses the signed-in
[Codex CLI](https://github.com/openai/codex) (`codex app-server`, checked with CLI 0.162.0),
so a ChatGPT plan works without an API key. Codex runs in the task's folder with its
workspace sandbox. Requests to run commands outside that sandbox, change protected files,
or approve MCP confirmations go through the board's permission flow. Plain command requests
covered by the task's tool rules are approved; auto-approve allows other requests unless
they are dangerous. Compound commands do not inherit a simple command's prefix rule.
Broad filesystem/network grants and MCP confirmations require an explicit answer.
Commands that Codex can already run inside its sandbox do not produce a board approval
request; the rules are applied to requests Codex sends, not to every command it executes.
Reviewers remain read-only and cannot obtain extra permissions. Only an edit task that
explicitly skips permissions runs without the Codex sandbox. Existing threads resume with
the task's current policy, including threads created by the earlier `codex exec` adapter.
Configured Codex writable roots and network access are preserved for editing sessions.
An installed CLI without the required app-server protocol fails the task instead of falling
back to an unsandboxed process. Interactive forms requiring entered values and MCP URL
flows are declined with a notice in the activity log; the board currently supports binary
approvals only. A Gemini profile uses the signed-in
[Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`, with the prompt on stdin). It can not ask
about a tool either: reviewers run in its `plan` mode plus an admin policy that lets them
only read and search files. The policy outranks your own Gemini allowances (settings,
`~/.gemini/policies`) and keeps headless Gemini from leaving plan mode for `yolo`. Gemini
ignores it on a machine with system policies (`/etc/gemini-cli/policies` and the like), so
there a Gemini reviewer is not started and its task fails; pick another reviewer. With no
shell, the harness runs `git log`, `git diff` and `git status` for them. Each output is saved whole
under `<data dir>/evidence/<task id>/`, which the reviewer may read (`--include-directories`);
the prompt quotes what fits in 12,000 characters and names the files for the rest. Gemini's read
tools skip the git-ignored `.harnessboard/notes.md`, so a copy of the notes goes there too. Tasks that
skip permissions (the default) run in `yolo` mode, and other tasks in `auto_edit` mode, where
shell commands are refused. Gemini does not report usage, so it has no quota reading on the
board; a usage-limit error pauses the task and retries it later. The Gemini adapter has not
been tried against the real CLI yet. How to add another CLI is in [architecture.md](architecture.md).

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

**Docker sandbox** (off by default): add `"sandbox": "docker"` and an image to a profile, and
every session of that profile runs in a container with `docker run`:

```json
{
  "agents": {
    "boxed": {
      "provider": "claude-code",
      "command": "claude",
      "model": null,
      "sandbox": "docker",
      "sandboxImage": "my-agents:latest"
    }
  }
}
```

- **Mounted, each at the same path as on your computer:** the task's folder, the git
  directory a worktree commits to (read-only for reviewers), the CLI's login and settings
  (`~/.claude` and `~/.claude.json`, `~/.codex` or `~/.gemini`) and a Gemini reviewer's
  evidence folder (read-only). Nothing else of your computer is visible to the agent.
- **You build the image:** it needs the profile's `command` on its PATH, plus whatever the
  task runs (git, node, your build tools). Harnessboard does not pull or build it.
- **Commits carry your git identity:** your `~/.gitconfig` is not mounted, so the `user.name`
  and `user.email` git uses in the task's folder are passed in as `GIT_AUTHOR_*` and
  `GIT_COMMITTER_*`. Nothing else from your git config is (commit signing, aliases, hooks
  paths). If git has no identity on your computer, commits fail in the container too; set one
  with `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`.
- **Gemini reviewers stay read-only:** the image's Gemini system policy folder
  (`/etc/gemini-cli/policies`) is replaced by an empty one they can not write to, so it can
  not switch off their read-only policy. A computer with its own system policies still
  refuses Gemini reviewers, in a container or not.
- **When docker is missing** or its daemon does not answer, the task fails with that reason;
  the agent is never run outside the container instead.
- **Limits:** Linux and macOS only (Windows paths can not be mounted at the same path). The
  agent runs with your user id and `HOME`; that home is an empty, writable folder that holds
  only what is mounted (the login, settings and task folder) and is thrown away with the container, so caches
  (`~/.npm` and the like) start empty on every session. No other environment variables are passed in, so
  sign in through the CLI rather than with an API key variable; `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME` and `GEMINI_CLI_HOME` are not followed. The network stays open, so the agent
  can still reach its API and anything else online. On SELinux hosts the container runs
  without SELinux labels instead of relabelling your folders. The git directory is the whole
  repository's, so the agent can still change other branches. Not yet tried with a real
  agent CLI in a container.
