# Loop mode

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
