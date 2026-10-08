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
| `--on-base` on `add` / `loop`                                                         | Work directly on the base branch, without a worktree (below)         |
| `hb plan <id>` / `hb feedback <id> <text>` / `hb approve <id> [--verify <command>]`   | Review, discuss and approve criteria or plan                         |
| `hb spec <id> <text>` / `hb reject <id>`                                              | Ask to change the spec after work started; reject a proposed change  |
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

**Working directly on the base branch** (`--on-base`, or **Work directly on …** in New
task) skips the worktree and the branch. The agent works in the repository folder itself, so
its commits land on the base branch as it goes and there is nothing to merge: approving the
review marks the task done. The card shows **on main** (or whichever branch it is).

- The base branch must be checked out in that folder when the task starts.
- Only one such task holds a folder at a time, from when it is queued until it is done,
  stopped or failed (review included). Starting another one there, or merging another task
  into that branch, is refused with the number of the task holding it.
- Its diff and commit list cover only what it committed while it held the folder, not
  commits you or other tasks made in between. Changes already uncommitted in the folder
  when it starts count as its work.
- `hb open` is refused for these tasks; use `hb chat` instead.
- Deleting one removes its history only: no folder and no branch.

**Deleting a task** (`hb delete`, or **Delete** in the task panel) removes its history and
its worktree folder, including edits that were not committed. The branch is kept, so
committed work can still be merged; remove it with `git branch -D` when you no longer need
it. Stop a running task first.

## Desktop app

Prefer an app to a terminal? The desktop app starts the server for you and shows the board
in its own window. **Click the icon and the board is there.**

- **Download:** every version has installers on the
  [Releases](https://github.com/AquilaWei/harnessboard/releases) page, with a
  `SHA256SUMS.txt` to check them against. A downloaded AppImage needs `chmod +x` before it
  runs.
- **Or build them yourself:** see [Building the installers](#building-the-installers)
  below.
- **Builds:** .deb (Debian, Ubuntu), .rpm (Fedora, openSUSE) and AppImage (any distribution)
  on Linux, .dmg (Intel and Apple silicon) on macOS, an
  installer (.exe) on Windows.
- **Still needed:** git and the agent CLIs (`claude`, `codex`, `gemini`). The app finds them the way
  your terminal does, including `~/.local/bin`, nvm and Homebrew.
- **Closing the window keeps it running** in the tray / menu bar, so tasks go on. Use
  **Quit Harnessboard** there to stop it; running agents are stopped cleanly. On a desktop
  without a tray (plain GNOME), launch the app again to bring the window back.
- **Works with `hb`:** if `hb serve` is already running, the app shows that server instead
  of starting a second one. The `hb` commands work against the app's server too.
- **Server log:** `<data folder>/logs/desktop-server.log`.
- **Not signed yet.** The first time you open it:
  - **macOS:** right-click the app → **Open** → **Open** (or System Settings → Privacy &
    Security → **Open Anyway**).
  - **Windows:** on the SmartScreen notice, **More info** → **Run anyway**.

### Building the installers

Each OS builds only its own installers: a .dmg needs a Mac, an .exe needs Windows. CI runs
the same steps on all three for every version tag. The files land in
**`packages/desktop/release/`**, named after the version (`Harnessboard-0.0.19-…`).

**Every OS first needs:** Node.js ≥ 22.13, Git, and a clone of this repository. If
`corepack` is missing (it is no longer bundled from Node 25 on), install it with
`npm install --global corepack@latest`. After pulling changes, run `pnpm build` again before
`dist`: it packages what the last build produced. The first `dist` downloads Electron
(~100 MB).

#### Linux: Ubuntu / Debian

```bash
corepack enable
pnpm install && pnpm build
pnpm --filter @harnessboard/desktop dist --linux deb AppImage   # → .deb and .AppImage
V=$(node -p "require('./packages/server/package.json').version")
sudo apt install ./packages/desktop/release/Harnessboard-$V-linux-amd64.deb
```

- **Use the .deb here.** It adds Harnessboard to the app menu and installs what it needs.
- The AppImage needs `libfuse2` (`libfuse2t64` on 24.04). On 24.04 it may also be stopped by
  the AppArmor sandbox rules, which the .deb is not.

#### Linux: Fedora

```bash
sudo dnf install rpm-build libxcrypt-compat   # rpmbuild, and libcrypt.so.1 for the fpm tool
corepack enable
pnpm install && pnpm build
pnpm --filter @harnessboard/desktop dist --linux rpm      # → .rpm
V=$(node -p "require('./packages/server/package.json').version")
sudo dnf install ./packages/desktop/release/Harnessboard-$V-linux-x86_64.rpm
```

- Harnessboard is then in the app menu. Remove it with `sudo dnf remove Harnessboard`; your
  tasks stay in the data folder.
- Without `libxcrypt-compat` the build stops with
  `libcrypt.so.1: cannot open shared object file`: the `fpm` tool electron-builder downloads
  needs it. `--linux AppImage` builds without it.
- **Why not Flatpak?** Harnessboard runs `claude`, `codex`, git and your projects' own tools.
  Flatpak's sandbox hides all of them from the app, so it would have to leave the sandbox for
  every command anyway.

#### macOS

```bash
xcode-select --install                        # Git and the build tools, if not installed yet
corepack enable
pnpm install && pnpm build
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @harnessboard/desktop dist   # → two .dmg
V=$(node -p "require('./packages/server/package.json').version")
open packages/desktop/release/Harnessboard-$V-mac-arm64.dmg   # Apple silicon; -mac-x64 for Intel
```

- Drag **Harnessboard** to **Applications**.
- `CSC_IDENTITY_AUTO_DISCOVERY=false` keeps electron-builder from signing with a developer
  certificate it finds in your keychain; the build is signed ad hoc, as the released one is.

#### Windows

In PowerShell, with [Git for Windows](https://git-scm.com/download/win) installed:

```powershell
corepack enable                               # run PowerShell as administrator for this line
pnpm install; pnpm build
pnpm --filter @harnessboard/desktop dist      # → .exe installer
$V = node -p "require('./packages/server/package.json').version"
.\packages\desktop\release\Harnessboard-$V-win-x64.exe
```

- `corepack enable` writes into the Node.js folder, so it needs an administrator
  PowerShell once; the other lines do not.
- The installer installs for your user only and lets you pick the folder.

Only the Fedora steps have been run on a real machine so far (building the .rpm). The Ubuntu, macOS and Windows
steps are what CI runs.

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

**Changing the spec after work has started:** once the spec file exists, a task that is
running, queued, in review, stopped or failed can still have its criteria changed.

1. **Ask:** click **Change the spec** in the task panel, say what should change and why, and
   send it (or `hb spec <id> "..."`). A running task finishes its current step first. The
   implementer can also stop and propose a change itself when it finds the spec wrong.
2. **The spec author proposes:** it reads the spec file and your message without changing
   anything, and answers with the complete revised criteria. The task waits in _Needs you_.
3. **You decide** on the **Criteria** tab, which shows the current criteria next to the
   proposed ones (or `hb plan <id>`):
   - **approve** (`hb approve <id>`, or `--criteria "..."`): edit the proposed criteria if you
     like, then approve. Harnessboard rewrites the criteria in the spec file, adds a dated
     line under "Revisions", commits it, and the implementer and later reviews work to the
     new criteria.
   - **reply** (`hb feedback <id> "..."`): the spec author proposes again.
   - **reject** (`hb reject <id>`): the spec stays as it is, and the task goes back to where
     it was.

**Designer (optional):** for work with a user interface, add a **designer**. After the spec
is committed, and before anything is built, it adds a "UI design" section to the spec file
(screens, layout, text, states and behaviour, in the project's existing style) and commits
it. The implementer is told to follow that section and the reviewer checks the work against
it. It may only change the spec file; anything else stops the task. Use
`--designer codex --designer-model <model>`, the **Designer** menu (None by default), or
`hb models <id> --designer <agent|none>`. It applies to single tasks whose criteria you
approve; leave it at None for work without a UI.

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
  a verdict, the task goes to Review for you to decide. Sending it back to work from there
  passes on the last review's points and gives the reviewer its rounds again.
- **Feature lists:** in a loop task each step is reviewed on the features marked done; the
  ones still to come are not held against it.
- **Default reviewer:** `defaultReviewer` in the config (or the web settings) applies to
  new tasks. `--reviewer none` turns review off for one task.
- **Your coding rules:** list files in `reviewGuidelines` (config or web settings), for
  example a coding-standards skill. Every review quotes them, as they are at that moment, and
  a broken rule counts as a required change. This works for any agent, Codex included:

  ```json
  { "reviewGuidelines": ["~/.claude/skills/coding-standards/SKILL.md"] }
  ```

**Models:** each task can pick its own model for the implementer and for the reviewer, for
example Haiku to build and Opus to review: `hb add "..." --model haiku --reviewer claude
--reviewer-model opus`, or the model menus in the New task dialog. Today the reviewer can be
any Claude Code, Codex or Gemini profile, so different vendors can check each other.

The model menus list what each platform offers your account, with its description: Claude
Code's own model menu (read from the catalog it caches under `~/.claude`, or its aliases
`opus`, `sonnet`, `fable` and `haiku` before it has one) and Codex's model catalog
(`codex debug models`). Older models sit under **More models**, and any other model id can
still be typed. Gemini CLI can not list its models, so for Gemini the model id is typed. On the command line: `hb agents --models <profile>`.

## Web board

`hb serve` also serves the board at **http://127.0.0.1:4317**:

- **Version next to the name:** the header shows the server's version (for example
  `v0.0.21`), in the browser and in the desktop app alike.
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
    or Continue with the review). When the reviewer still wants changes, its points are shown
    right there.
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
- **Quota:** the header shows the 5-hour usage of each platform you use (Claude, Codex);
  click one for both windows and the pause level. Each platform pauses on its own. Claude
  Code reports usage while it runs; Codex does not, so Harnessboard reads it every minute
  from the session logs Codex keeps under `~/.codex/sessions`, which also counts what you
  used in Codex yourself.
- **Settings:**
  - Concurrency, quota pause level, default task size and default reviewer. These are saved
    to your user config file.
  - The agent profiles and whether each CLI runs.
  - Language (English, 繁體中文) and theme (system, light, dark), which apply to this browser
    only.
  - **Notify me when a task needs me:** a desktop notification from this browser when a task
    waits for permission, approval or review, or fails, while the board is open but not in
    front. Click it to open the task.

The API accepts only loopback `Host` headers, plus the remote hosts you add for
[phone access](#phone-access), and it requires a custom header on every write. A web page you
visit cannot drive your agents through the browser.

## Phone access

Follow progress, approve, answer and create tasks from your phone, from anywhere. The board
stays on your computer; the phone reaches it through [Tailscale](https://tailscale.com), so
nothing is opened to the internet.

1. **Install Tailscale** on the computer and the phone, signed in to the same tailnet. Turn
   on MagicDNS and HTTPS certificates in the Tailscale admin console.
2. **Add the remote host:** on the computer, open **Settings → Phone access**. It shows this
   computer's Tailscale name (`<machine>.<tailnet>.ts.net`); click **Add as remote host**
   and **Save**.
3. **Serve the board on the tailnet**, once, with the command the section shows (the port is
   the board's, 4317 by default):

   ```bash
   tailscale serve --bg 4317
   ```

   The first HTTPS request can take about 30 seconds while Tailscale issues the certificate.
   `tailscale serve reset` turns it off again.

4. **Pair the phone:** click **Pair a phone** and scan the QR code with the phone's camera.
   The code works once, for 5 minutes. Give the phone a name, tap **Pair**, then **Create passkey**:
   the phone asks for your fingerprint, face or screen lock. The phone is paired only once
   the passkey is made.
5. **Add to Home Screen** (optional on Android, needed for push on an iPhone): in Chrome's
   menu, **Add to Home Screen** (on Safari, in the Share menu). The Harnessboard icon then
   opens the board full screen, without the address bar.
6. **Turn on push notifications** (optional): on the phone, open **Settings** and switch on
   **Notify me when a task needs me**, then allow notifications. The phone gets a push when
   a task waits for permission, approval or review, or fails, even with the board closed.
   Tapping it opens the task on the tab that needs you (after unlocking, if the board was
   locked). A push carries only the task's number, title and status, never its changes or
   chat. Switching it off, or revoking the phone, stops the pushes.

**How the passkey protects the board**

- **Unlock:** the board locks each time it is opened on the phone (a reload or a server
  restart counts) and after 30 minutes without use. **Unlock** asks for the passkey.
- **Sensitive actions** ask again when the last check is more than 5 minutes old: creating,
  starting, approving, answering, merging or deleting tasks, and changing settings, agents,
  tool rules or paired devices. The action carries on once you confirm.
- **Lost phone:** revoke it under **Settings → Phone access → Paired devices**; it loses
  access on its next request. There are no backup codes: pair the new phone the same way.
- **Browsers inside apps** (LINE, for example) cannot use passkeys. The board says so; open
  the page in Chrome or Safari from the app's menu, and the pairing code goes along.
- **On the computer itself** nothing changes: no pairing and no passkey.

**Recommended Tailscale settings**

- **Two-factor login** on the account that owns the tailnet.
- **Device approval**, so a new device cannot join the tailnet without you.
- **An access rule (ACL)** that lets only your phone reach this computer, so other devices
  or shared nodes in the tailnet cannot even load the pairing page.

**Limits**

- **The computer must be on** and Harnessboard running (desktop app or `hb serve`). A
  sleeping computer cannot be reached.
- **Push notifications on an iPhone** need iOS 16.4 or later and the board opened from the
  Home Screen; in Safari itself the switch says push is not available.
- Tailscale Funnel (the public internet) is always refused. Another HTTPS reverse proxy
  works too: add its host name as a remote host.

### Android app

The Android app (Android 8.0 or later, with Chrome) opens the same phone board with its own
icon. It runs the board in Chrome's engine, so it needs the Tailscale setup above (steps 1–3)
like the browser does.

1. **Install it:** download `harnessboard-<version>.apk` from the
   [releases page](https://github.com/AquilaWei/harnessboard/releases) on the phone and open
   it. Android asks once to allow installs from Chrome (or your file manager).
2. **Connect:** open **Harnessboard** and tap **Scan pairing QR**, then scan the QR code from
   **Settings → Phone access → Pair a phone** on the computer. Without a QR code, type the
   board's address (`https://<machine>.<tailnet>.ts.net`) and tap **Connect**.
3. **Pair:** the board opens inside the app with the pairing screen. Name the phone, tap
   **Pair**, then **Create passkey**, as in step 4 above. The app keeps the address; later the icon opens
   the board directly.

**What changes compared with the browser**

- **No URL bar**, once the board's asset links are verified (see below); the board fills the
  screen.
- **Its own icon and its own entry in the task switcher**, separate from Chrome's tabs.

**What stays the same**

- **Passkey, lock and push rules:** the same passkey, the 30-minute lock, the check before
  sensitive actions and the same push notifications.
- **Chrome's storage:** the app uses Chrome's cookies and site data, so a phone already
  paired in Chrome stays paired; just type the address in step 2.
- **Revoking** the phone on the computer locks out the app and Chrome together.

**Push in the app:** when you turn on push, Android asks whether **Harnessboard** may send
notifications. The pushes then come from the app, and tapping one opens the task in the app,
even when the app was closed. This needs the board's asset links verified (no URL bar, see
below); otherwise Chrome shows the pushes and a tap opens a Chrome tab. On Android 8–11 the app
can appear in "Open with" lists for web links, because it takes the board's links; links to other
sites are passed on to your browser.

**Change board:** long-press the app icon and tap **Change board**. The app forgets the
address and shows the setup screen again; the computer still lists the phone until you
revoke it.

**URL bar still showing?** The board tells Android which apps it trusts through
`/.well-known/assetlinks.json`, using the app's signing fingerprints. For a released APK,
copy the fingerprint printed in the release's CI log; for an app you built yourself, its own
(see [Development](#development)). Paste it under **Settings → Phone access → Android app →
App signing fingerprints**, **Save**, then clear Chrome's data for the app or reinstall it
so Android checks again.

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
`--compact <pct>` or `compactPct` in a context policy; `0` turns it off. While compaction is
on, the soft and hard thresholds do not act within a turn: the agent is not asked to wrap up
and is not cut off, and the turn finishes and is compacted. Only a context at 90 % or more
ends a turn early, so a runaway turn can not overflow the window. With compaction off, or for
an agent that can not be compacted, the soft and hard thresholds apply within the turn.

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

Supported providers: `claude-code`, `codex` and `gemini`. A Codex profile uses the signed-in
[Codex CLI](https://github.com/openai/codex) (`codex exec`), so a ChatGPT plan works without
an API key. Codex can not ask about a tool: its sandbox decides, so permission rules and
prompts do not apply to it. A Gemini profile uses the signed-in
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
been tried against the real CLI yet. How to add another CLI is in [docs/architecture.md](docs/architecture.md).

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

## Development

```bash
corepack enable        # provides the pinned pnpm version
pnpm install
pnpm test              # uses a fake claude CLI; no account needed
# optional: also run the Gemini read-only policy tests against Gemini's own policy engine
npm install --no-save --prefix /tmp/gemini-core @google/gemini-cli-core@0.62.0
HARNESSBOARD_TEST_GEMINI_CORE=/tmp/gemini-core/node_modules/@google/gemini-cli-core pnpm test
pnpm lint && pnpm typecheck
pnpm --filter @harnessboard/web dev   # UI with hot reload; proxies /api to a running `hb serve`
```

**Android app** (in `android/`, still in progress): it needs a JDK and the Android SDK with
platform 37, found through `ANDROID_HOME` or the default install folder. See
[Android app in CONTRIBUTING.md](CONTRIBUTING.md#android-app) for the setup.

```bash
pnpm android:check                              # ktlint, unit tests, Android lint, debug APK
HARNESSBOARD_SKIP_ANDROID=1 pnpm android:check  # skip it on a machine without the SDK
```

**Release signing key for the APK.** On a `v*` tag, CI builds `harnessboard-<version>.apk`,
signs it and adds it, with its SHA256, to the draft release. The key lives only in the repo's
GitHub secrets; **without them the release job stops** (an unsigned APK will not install).
Create the key once, **outside the repo**, and keep a backup: Android only installs an update
signed with the same key.

```bash
keytool -genkeypair -v -keystore ~/harnessboard-release.jks -storetype PKCS12 \
  -alias harnessboard -keyalg RSA -keysize 4096 -validity 10000
base64 < ~/harnessboard-release.jks | gh secret set HB_ANDROID_KEYSTORE
gh secret set HB_ANDROID_KEYSTORE_PASSWORD   # prompts; the password you gave keytool
gh secret set HB_ANDROID_KEY_ALIAS --body harnessboard
gh secret set HB_ANDROID_KEY_PASSWORD        # prompts; the same password (PKCS12 has one)
keytool -list -v -keystore ~/harnessboard-release.jks -alias harnessboard | grep SHA256:
```

The last line prints the key's **public** SHA-256 fingerprint (CI prints it too); it becomes
the default of the `androidAppFingerprints` setting so the app opens without a URL bar.
To build a release APK yourself, set the same four variables before
`cd android && ./gradlew assembleRelease`; without them it builds `app-release-unsigned.apk`.
The debug APK from `pnpm android:check` (`android/app/build/outputs/apk/debug/app-debug.apk`)
is signed with this computer's debug key; print its fingerprint with:

```bash
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android | grep SHA256:
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose changes and
[CHANGELOG.md](CHANGELOG.md) for what changed in each version. Notes on the Claude Code
output format that Harnessboard relies on are in
[docs/stream-json-notes.md](docs/stream-json-notes.md).

## License

[Apache-2.0](LICENSE). Harnessboard is an independent project and is not affiliated with
Anthropic. The licenses of the packages bundled in the web board are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
