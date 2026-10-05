# Architecture

This page is for contributors. It covers how Harnessboard is put together, how agents and
roles fit in, and what adding another agent CLI (such as Gemini) involves.

## Packages

```
web (React) ──REST/SSE── server (Hono, `hb` CLI)
                           └─ core
                               ├─ Harness     task lifecycle, public API, event fan-out
                               ├─ scheduler   concurrency limit, per-provider quota pause
                               ├─ Workflow    who runs the next session, with what prompt,
                               │              and where the task goes afterwards
                               ├─ runner      one agent session: spawn, parse, context budget
                               ├─ providers   agent profile → AgentAdapter
                               ├─ loop        feature list, harness-run verification
                               ├─ review      reviewer prompt and verdict parsing
                               ├─ worktree    git worktrees and diffs
                               └─ Store       SQLite (node:sqlite): tasks, sessions, events
```

`shared` holds the types that cross package boundaries: the API views, events, and
profiles.

`desktop` is the Electron app. Its main process (`src/main.ts`) does four things:

- It reads the PATH from a login shell (`shell-path.ts`), so agent CLIs are found when the
  app starts from a launcher.
- It asks the configured port whether Harnessboard already runs there (`probePort`). If
  nothing is there, it starts the server in Electron's own Node, through
  `utilityProcess.fork`.
- It shows the board in a window.
- It stays in the tray when the window is closed.

The server it starts is `server/src/desktop.ts`, bundled with all its dependencies into
`dist/server.mjs`. That entry takes no arguments, because Commander misreads argv in a
utility process. Quit sends it a `shutdown` message over the parent port
(`runServer` in `server/src/run.ts`). Windows has no SIGTERM for that process, so the
message is how it stops cleanly; after 10 s the app kills it.

The installers come from `electron-builder`. They take their version from
`packages/server/package.json`, through `scripts/dist.mjs`.

## Agents, profiles and roles

- **Provider:** an agent CLI Harnessboard knows how to drive. Today there are two,
  `claude-code` and `codex`. Each provider has one `AgentAdapter`.
- **Profile:** a named way to run a provider, set in the user config. It holds a command,
  a model, and optionally a context window. `claude` always exists. Adding a second profile
  (for example the same CLI with another model) needs no code.
- **Role:** what a session is asked to do.
  - `spec`: agrees acceptance criteria with the user before anything is built. The
    discussion runs read-only. After approval the same role writes the agreed spec to
    `docs/specs/<id>-<title>.md` and commits it (edit access; `spec_written` event). The
    harness stops the task if anything else changed, and commits the file itself when the
    author left it uncommitted. `Workflow.goal()` tells later agents to read the file.
    The proposal also carries a short design (files, interfaces, risks), which goes into the
    file, so there is no separate designer. `task.agents.spec` is optional; without it the
    implementer plays this role. When the same agent plays both roles the spec-writing session is also what the implementer
    resumes; otherwise the implementer starts a new session from the approved criteria.
  - `implementer`: edits files and commits. For a task with a spec file it is also told to
    keep the README, changelog and docs in step (`DOCS_DUTY`), and the reviewer checks that.
  - `tester`: optional, single tasks only. After an implementer step, one session with edit
    access writes the missing tests, runs them and commits them, then answers
    `TESTS: PASS` or `TESTS: FAIL`. Events: `test_request`, `test_report`. A failure is
    open feedback for the implementer like a review's `CHANGES` (`openFeedback`), counted
    against `maxReviewRounds`; a pass sends the step on to the reviewer. The harness checks
    the files changed since the request (`changedPaths`) and stops the task if any is not a
    test path (`isTestPath`).
  - `reviewer`: checks the implementer's latest step. It runs read-only and must answer
    with `VERDICT: APPROVE` or `VERDICT: CHANGES`.

  A task names a profile for each role (`task.agents`).

  **Notes between roles.** Every workflow session except the discussion with the user is
  asked (`notesPrompt`) to end its reply with a `## Notes` section. When it completes,
  `Workflow.recordNote` stores the section (or the whole reply) as a `role_note` event with
  the role, agent and verdict, and renders all notes into `.harnessboard/notes.md` in the
  worktree (`core/src/notes.ts`). Later sessions are told to read that file first. The
  events are the record: `syncNotes` rewrites the file from them before every session, so an
  agent's edit to it never reaches the next role, and the directory is listed in the
  repository's `info/exclude`, so the file is never a change (the reviewer's unchanged-worktree
  check and the tester's test-paths-only check do not see it). `GET /api/tasks/:id/notes`
  renders the same notes for the web UI.

The reviewer loop lives in `core/src/workflow.ts`:

```
implementer step done ──► review_request ──► reviewer session (read-only)
        ▲                                         │
        │ changes (≤ maxReviewRounds)             ├─ APPROVE  → next feature / Review
        └─────────────────────────────────────────┤─ CHANGES  → feedback to implementer
                                                  └─ no verdict, over the round limit,
                                                     or files changed → a human
```

For a single task the roles run in this order:

```
spec ─► spec file ─► implementer ─► tester ─► reviewer
```

The tester is off unless the task names an agent for it; the spec author defaults to the
implementer, and the reviewer to `defaultReviewer`. A
failing test report or a `CHANGES` verdict returns to the implementer, and the step then
passes through the later roles again.

`reviewGuidelines` (user config) names files with the user's rules. `reviewPlan` reads them
for every review (`core/src/guidelines.ts`) and `reviewPrompt` quotes them whole, so the
rules reach any agent CLI without it loading anything itself. A file that can not be read
fails the review session rather than letting it run without the rules; saving the setting
checks the files first.

A step counts as done when a single task's session completes, or when the harness has
verified a loop feature. `review_request` and `review` are events in the store, so a
restart picks up exactly where the task was. A loop step's reviewer gets the latest feature
snapshot: the features marked done are what it judges, and the features still to come are
listed as out of scope, so an unfinished list is never a reason to ask for changes.

Rounds count from the step's last pass (`APPROVE`, `TESTS: PASS`) or from the last
`sent_back` event, which `Harness.queueTask` records when a human sends a task in review back
to work. The implementer then gets the last review's feedback, and the reviewer and tester
get `maxReviewRounds` again.

## Adding an agent CLI

1. Add the provider id to `AGENT_PROVIDERS` in `shared/src/agents.ts`.
2. Implement `AgentAdapter` (`core/src/agent.ts`) in a new file, and register it in
   `core/src/providers.ts`.
3. Parse the CLI's output into `AgentEvent`s. The harness depends on these:
   - `init` with the CLI's session id
   - `context`: tokens currently in the context window, after each model call
   - `result`: the final reply, whether it is an error, and the context window if the CLI
     reports one
   - `quota`, if the CLI reports usage limits
4. Declare `capabilities` honestly. The runner adapts to them:

   | Capability          | `true` / `harness`                                                                             | `false` / `agent`                                                                             |
   | ------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
   | `midTurnInput`      | Prompt and wrap-up request are written to stdin during the turn                                | Prompt goes in the arguments; the wrap-up is sent by resuming the session after the turn ends |
   | `sessionIds`        | The harness picks the id and passes it                                                         | The id comes from `init` and is stored as `agent_session_id`; resume and `hb open` use it     |
   | `permissionPrompts` | A tool outside the rules emits `permission_request`; the CLI waits for `encodePermissionReply` | Such tools are refused; the user widens the rules with `hb tools` and runs the task again     |

5. Map `SessionSpec.access: 'readOnly'` to the CLI's most restrictive mode. Reviewers rely
   on it. The harness also compares HEAD and `git status` before and after every review,
   and stops the task if anything changed.
6. Add tests that drive a scripted fake CLI (see `core/test/fixtures/fake-claude.mjs` and
   `PromptArgAdapter` in `core/test/helpers.ts`, which already acts like a prompt-as-argument
   CLI).

## The Codex adapter

`core/src/codex.ts` drives `codex exec --json`, checked against Codex CLI 0.160:

- Capabilities: `midTurnInput: false`, `sessionIds: 'agent'`, `permissionPrompts: false`.
- The result's text is the turn's last `agent_message`. Adapters are shared by all sessions
  of a profile, so this needs state per process: an adapter may provide `createParser()`,
  which the runner calls once for each CLI process.
- `exec resume` accepts `-c` but not `--sandbox`, so the sandbox is set with
  `-c sandbox_mode=...` in both cases. Reviewers get `read-only`.
- The workspace sandbox protects a worktree's git directory, which lies outside the
  worktree, so an implementer there can not commit. Edit sessions that skip permissions
  (the default for tasks) therefore run with `--dangerously-bypass-approvals-and-sandbox`.
- `turn.completed` sums tokens over every model call of the turn, which is not the size of
  the context, so no `context` events are emitted and Codex manages its own context.
- Not seen in real output yet, so read defensively: `file_change` items and usage-limit
  errors (a message containing "usage limit" or "rate limit" counts as 429).

## Notes for the planned providers

These come from the vendors' documentation and have not been checked against real output
yet. Check them against the real CLIs before relying on them.

- **Google Gemini CLI:**
  - `gemini -p "<prompt>" --output-format stream-json` prints JSONL events: `init` (with the
    session id), `message`, `tool_use`, `tool_result`, `error` and `result` (with stats).
  - It resumes with `--resume <id>`.
  - Capabilities: `midTurnInput: false`, `sessionIds: 'agent'`, `permissionPrompts: false`.
  - Read-only mode: check which approval mode or sandbox flag refuses edits.

Gemini does not report a subscription quota the way Claude Code's `rate_limit_event` does.
Its adapter should report a usage-limit error as an error `result` with
`apiErrorStatus: 429`. The task then waits `quotaRetryMinutes` and retries.

## Data and state

- **Where data lives:** everything durable is in the SQLite store. Tasks and sessions are
  tables. Everything else is in the `events` table: the agent's output, notices, handoff
  notes, feature snapshots, review requests and reviews.
- **In-memory state:** `Harness` keeps only the running sessions, the latest quota per
  provider, and each running task's current phase. After a restart, the quota is restored
  from events, and tasks that were running are queued again.
- **Schema changes:** migrations live in `core/src/store.ts`. Never edit a shipped entry.
  Add a new one, plus a test that upgrades a database in the previous format.

## Plans

- [Phone access](plans/phone-access.md): using the board from a phone over Tailscale, with
  device pairing and a passkey. Planned, not started.
