# Command line (`hb`)

Every `hb` command and flag, and how merging, working on the base branch and deleting behave.

## Commands

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
| `--effort <level>` / `--reviewer-effort <level>` on `add` / `loop`                    | Choose how deeply each role reasons (below)                          |
| `hb agents` / `hb agents --models <profile>`                                          | List agent profiles, and agent CLIs found without one / their models |
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

**Choosing models and reasoning effort.** Each role of a task (implementer, spec author,
designer, tester, reviewer) has a model and a reasoning effort, the level of thinking the
model spends on each answer. Left out, the profile's model and effort apply, and without those
the CLI's own defaults.

| Role        | Model on `add` / `loop` / `models` | Effort on `add` / `loop` / `models` |
| ----------- | ---------------------------------- | ----------------------------------- |
| Implementer | `--model <m>`                      | `--effort <level>`                  |
| Spec author | `--spec-model <m>`                 | `--spec-effort <level>`             |
| Designer    | `--designer-model <m>`             | `--designer-effort <level>`         |
| Tester      | `--tester-model <m>`               | `--tester-effort <level>`           |
| Reviewer    | `--reviewer-model <m>`             | `--reviewer-effort <level>`         |

- **Which levels exist** depends on the model: `hb agents --models <profile>` prints each
  model with an indented `efforts: low, medium, high, …` line of the ids the options take,
  plus `(default medium)` when the CLI names its default. Claude Code and Codex take an
  effort; Gemini CLI does not, so its models list none. The server refuses an id that is not
  a single word.
- **`hb models <id>`** prints each role with its profile, model and effort; an effort left
  to the profile or CLI shows `(default effort)`. The spec author without its own profile is
  shown as `(the implementer)` with the model and effort it runs with. Any of the options
  above changes them; `default` clears a model or effort. Models and efforts can change while
  the task runs and apply from its next session.
- **Changing a role's model clears its effort** unless the same command sets one too, so a
  level the new model does not offer is not kept by accident.

```bash
hb add "Refactor the parser" --model opus --effort high --reviewer codex --reviewer-effort low
hb models 12 --effort max          # the implementer thinks harder from the next session on
hb models 12 --effort default      # back to the profile's or CLI's default
```

**Merging a task** (`hb merge`, or **Merge into main** in the task panel of a task in
review) merges its branch into the branch it started from with a merge commit,
`chore: merge task #N` (the title is in the message body), keeping every commit of the task. The task is then done, and its
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
