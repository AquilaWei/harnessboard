# Task workflow: criteria, roles and review

How a task is agreed, built, tested and reviewed, and which agent does each part.

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
**Tester** menu, or `hb models <id> --tester <agent|none>`. It applies to single and loop tasks. The tester owns formal stage verification; the implementer may still run focused tests while developing. When a loop has a tester, Harnessboard does not run the same verification command again.

**Notes between roles:** every role ends its reply with a `## Notes` section for the roles
after it: what it did, the decisions it made, what it is unsure of and what to check next.
Harnessboard records each one and keeps them in `.harnessboard/notes.md` in the task's
worktree, oldest first. A resumed implementer receives only new reviewer/tester feedback; a fresh implementer can read the archive. Testers and reviewers consult history only when a specific ambiguity requires it. Only
Harnessboard writes this file: it is rebuilt from its own records before every session, so
no agent can change another's report, and git ignores it, so it never reaches a commit. Read
it on the task's **Notes** tab. A role that writes no notes section is recorded with its
whole reply. The discussion with you is not part of it; its outcome is the spec file.

When the reviewer asks for changes, the fix goes back through the tester (if there is one)
before the reviewer sees it again.

Criteria given when creating the task are used as they are. `--no-discuss` (or unticking
the box in the New task dialog) starts without criteria.

## Reviewer: agents checking each other

Give a task a reviewer, and every finished step is checked by a second agent before the task
moves on. A step is a finished single task, or a verified Loop feature.

```bash
hb add "Add input validation to the signup form" --reviewer opus
```

- **Read-only:** the reviewer runs in the same worktree but can only read files and run
  `git diff`, `git log` and `git show`. If it changes anything anyway, the task stops for
  you.
- **Static review:** check architecture, logic, test coverage and the configured code rules. Do not rerun tests, lint or builds; formal execution belongs to the tester.
- **Verdict:** the reviewer answers `VERDICT: APPROVE` or `VERDICT: CHANGES` followed by
  what to fix. Requested changes go to the implementer's next turn in its own session.
- **Bounded:** after `maxReviewRounds` (2) rounds of requested changes, or a reply without
  a verdict, the task goes to Review for you to decide. Sending it back to work from there
  passes on the last review's points and gives the reviewer its rounds again.
- **Feature lists:** in a loop task each step is reviewed on the features marked done; the
  ones still to come are not held against it.
- **Persistent conversations:** the implementer, tester and reviewer each keep a separate
  session across stages and fixes. Follow-up checks receive changed scope; implementers receive new feedback.
  updated requirements or review rules are sent again when they change. Every successful
  stage is compacted by adapters that support it; see [context budget](configuration.md#context-budget).
- **Default reviewer:** `defaultReviewer` in the config (or the web settings) applies to
  new tasks. `--reviewer none` turns review off for one task.
- **Your coding rules:** list files in `reviewGuidelines` (config or web settings), for
  example a coding-standards skill. The first review quotes them, and later reviews send
  updated rules when they change, and
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

## Commit checks before handoff

Harnessboard checks writing stages before handing work to another role: the worktree must
be clean and every commit made since that stage began must use one English line,
`<type>: <description>`, with `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test` or
`chore`. Review checks any additional project code rules. A clean stage without changes
needs no empty commit, and a read-only reviewer does not commit. The check runs locally,
without an agent call or rereading the entire Git history.

A failed check stops the task with a notice and preserves the session and files. Correct
the problem and queue it again; the original stage range remains subject to the check.
Harnessboard never rewrites commit history automatically. Spec and design stages retain
their existing single-file commit fallback, then undergo the same check.
