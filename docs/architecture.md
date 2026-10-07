# Architecture

This page is for contributors. It covers how Harnessboard is put together, how agents and
roles fit in, and what adding another agent CLI involves.

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
    file; the user interface is left to the optional `designer`. `task.agents.spec` is optional; without it the
    implementer plays this role. When the same agent plays both roles the spec-writing session is also what the implementer
    resumes; otherwise the implementer starts a new session from the approved criteria.
  - `designer`: optional, off by default (`task.agents.designer` absent or `null`), for
    tasks with a user interface. Once `spec_written` is recorded, one session with edit access
    adds a `## UI design` section to the spec file and commits it (`designPrompt`;
    `design_written` event). The harness stops the task if any other file changed since the
    spec was committed (for a `base` task, only within its own commit spans, so others'
    commits in the folder are not counted), or the file has no such heading, and commits the
    file itself when the designer left it uncommitted. From then on `taskGoal` and
    `criteriaApprovedPrompt` tell the implementer and the reviewer to follow that section.
    The designer runs only for a task with a spec file (a single task whose criteria were
    approved), and not when it is chosen after the implementer has started. The start is the
    `implementation_started` event the first implementer session after the spec logs, once
    its agent reports anything; the designer's, a chat's and the spec author's revision
    sessions do not count. Spec change decisions made before that are not sent as a separate
    session: the implementer's first prompt already carries the decided criteria. Its
    session is never one the implementer resumes.
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
spec ─► spec file ─► designer ─► implementer ─► tester ─► reviewer
```

The designer and the tester are off unless the task names an agent for them; the spec author defaults to the
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

**Spec changes.** Once a single task's spec file is written (`spec_written`), its criteria
can change through the same approval as the first spec. Two ways in:

- The user asks (`Harness.requestSpecRevision`, `POST /api/tasks/:id/spec-revision`; on the
  board **Change the spec**, which shows while `canChangeSpec` holds for the view's
  `specFile` and status, and `hb spec`), stored as
  a `spec_revision` event. The next session is the spec author's, read-only and in a new
  conversation (`specRevisionPrompt`), and it comes before a pending review or test. A
  request made while a session or a chat runs waits for it to end; a task that then lands
  in review goes back in line for it (`reviseAfterStep`). The proposal records the id of
  the request it answers (`requestId`), so a request that came in meanwhile stays waiting:
  the spec author answers it next, starting from that proposal, and the user decides only
  on the answer to the latest request.
- The implementer ends its reply with a `SPEC CHANGE: <why>` line and the complete revised
  list (`parseSpecChange`). Implementers of a task with a spec file are told how
  (`SPEC_CHANGE_DUTY`). The step is then not sent for review or test.

Either way a `spec_change` proposal (`SpecChangeProposal`: old and new criteria, who, why)
puts the task in `awaiting_approval`, and nothing is built until the user decides. A reply
(`planFeedback`) becomes a new `spec_revision`. `approveCriteria` approves a waiting change
too (`approveSpecChange`), and `rejectSpecChange` rejects it; both store a
`spec_change_decision`. On approval the criteria are saved on the task, so every later
goal, review and test uses them. Before the next session, `Workflow.reviseSpecFile`
rewrites the criteria section of the spec file and adds a dated line under "Revisions"
(`core/src/spec.ts`), then commits only that file (`spec_revised`). The harness writes the
file itself so it holds exactly the approved criteria. The implementer is then resumed with
the new criteria (`specChangeApprovedPrompt`). A rejection leaves the file and criteria as
they were. The implementer's own proposal is answered with `SPEC_CHANGE_REJECTED_PROMPT`;
a user's request returns the task to review if it was there, and to the queue otherwise.
A session whose prompt carries a request or decisions logs a `spec_delivered` event for
each as it starts (`Workflow.started`). The spec author's revision sessions, told by the
request delivered to them, are never what the implementer resumes (`withoutRevisions`),
even one cut off before it proposed anything. A decision counts as heard only once the agent of
such a session reported anything after it (`Store.sessionHasAgentEventsAfter`): a chat in
between does not use it up, and neither does a launch that failed, for which the harness
still logs usage, stderr and the deliveries themselves. Every unheard
approval and rejection of the implementer's own proposal is told together, so rejecting a
later request of the user does not hide an approval the implementer has not heard yet.
`Workflow.nextStep` picks what the next session is for, and both `nextSession` and the
quota check (`nextAgentId`) go by it.

Rounds count from the step's last pass (`APPROVE`, `TESTS: PASS`) or from the last
`sent_back` event, which `Harness.queueTask` records when a human sends a task in review back
to work. The implementer then gets the last review's feedback, and the reviewer and tester
get `maxReviewRounds` again.

## Adding an agent CLI

1. Add the provider id to `AGENT_PROVIDERS` in `shared/src/agents.ts`.
2. Implement `AgentAdapter` (`core/src/agent.ts`) in a new file, and register it in
   `core/src/providers.ts`. List the CLI's login and settings in `configPaths`, so the
   Docker sandbox can mount them.
3. Parse the CLI's output into `AgentEvent`s. The harness depends on these:
   - `init` with the CLI's session id
   - `context`: tokens currently in the context window, after each model call
   - `result`: the final reply, whether it is an error, and the context window if the CLI
     reports one
   - `quota`, if the CLI reports usage limits
4. Declare `capabilities` honestly. The runner adapts to them:

   | Capability          | `true` / `harness`                                                                             | `false` / `agent`                                                                                                      |
   | ------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
   | `midTurnInput`      | Prompt and wrap-up request are written to stdin during the turn                                | Prompt goes in the arguments, or on stdin with `encodePrompt`; the wrap-up is sent by resuming the session             |
   | `sessionIds`        | The harness picks the id and passes it                                                         | The id comes from `init` and is stored as `agent_session_id`; resume and `hb open` use it                              |
   | `permissionPrompts` | A tool outside the rules emits `permission_request`; the CLI waits for `encodePermissionReply` | Such tools are refused; the user widens the rules with `hb tools` and runs the task again                              |
   | `readOnlyGit`       | A read-only reviewer runs `git log`, `git diff` and `git status` itself                        | The harness runs them, saves the output to files the reviewer may read, and quotes it in the prompt (`reviewEvidence`) |

5. Map `SessionSpec.access: 'readOnly'` to the CLI's most restrictive mode. Reviewers rely
   on it. The harness also compares HEAD and `git status` before and after every review,
   and stops the task if anything changed.
6. Add tests that drive a scripted fake CLI (see `core/test/fixtures/fake-claude.mjs`,
   `core/test/fixtures/fake-gemini.mjs` and
   `PromptArgAdapter` in `core/test/helpers.ts`, which already acts like a prompt-as-argument
   CLI).

## The Codex adapter

`core/src/codex.ts` drives `codex exec --json`, checked against Codex CLI 0.160:

- Capabilities: `midTurnInput: false`, `sessionIds: 'agent'`, `permissionPrompts: false`,
  `readOnlyGit: true` (the read-only sandbox still runs commands that do not write).
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

## The Gemini adapter

`core/src/gemini.ts` drives `gemini --output-format stream-json` with the prompt on stdin. Its event
names and fields follow the stream-json types in the Gemini CLI source
(`packages/core/src/output/types.ts`) and the CLI reference; it has not been checked against
a real run yet.

- Capabilities: `midTurnInput: false`, `sessionIds: 'agent'`, `permissionPrompts: false`,
  `readOnlyGit: false`.
- Output is JSONL: `init` (with `session_id` and `model`), `message` (`role`, `content`, and
  `delta: true` for chunks), `tool_use`, `tool_result`, `error` (`severity`, `message`) and
  `result` (`status`, `error`, `stats`). The parser joins assistant chunks into one message,
  which ends at the next `tool_use` or at the `result`; the result's text is the last
  message, so the adapter provides `createParser()` like Codex.
- The prompt goes to stdin (`encodePrompt`), which the runner closes after it: Gemini runs
  headless when stdin is not a terminal and takes all of it (up to 8 MB) as the prompt. An
  argument would fail on Windows, where `gemini` is a `gemini.cmd` shim run through cmd.exe,
  whose whole command line holds at most 8,191 characters; a review prompt with its evidence
  is often longer. On stdin a prompt starting with `-` is not read as an option either. It
  resumes with `--resume <session id>`, and `hb open` runs `gemini --resume <session id>`.
- Access maps to `--approval-mode`: `plan` (read-only) for reviewers, `yolo` for edit sessions
  that skip permissions, and `auto_edit` for the others. Without a terminal nothing can answer
  an approval, so under `auto_edit` shell commands are refused and the session can not
  commit. Plan mode alone is not read-only: headless, Gemini approves `exit_plan_mode` by
  itself and then switches to `yolo`, and the user's own allowances (`tools.allowed`,
  `--allowed-tools`, rules in `~/.gemini/policies`, all user tier 4.x) outrank plan mode's
  refusals (default tier 1.x). Every read-only session, new or resumed, therefore also gets
  `--admin-policy` with a policy file the adapter writes once per process into a private
  temporary directory (`read-only.toml`, rewritten if it was cleaned away). Admin rules rank
  5 + priority / 1000: a catch-all deny (5.900) refuses every tool in every mode, MCP tools,
  subagents and `exit_plan_mode` included, and an allowlist above it (5.950) lets through
  only `read_file`, `read_many_files`, `glob`, `grep_search`, `list_directory` and
  `google_web_search`, so the evidence directory can still be read. Gemini ignores
  `--admin-policy` once its system policy directory (`/etc/gemini-cli/policies`,
  `/Library/Application Support/GeminiCli/policies` or `C:\ProgramData\gemini-cli\policies`)
  holds a `.toml` file, so `buildArgs` then throws and the runner reports the session as
  failed to start instead of running a reviewer that could write. `gemini-policy.test.ts`
  runs the generated file through the policy engine of `@google/gemini-cli-core` 0.62.0
  (installed by CI outside the workspace, `HARNESSBOARD_TEST_GEMINI_CORE`; skipped without
  it) next to user allowances for writes and shell and next to a system policy; a real CLI
  run is still unchecked. The harness's git check
  after a review still runs, but only finds changes once they are made. Plan mode allows no
  shell, so a Gemini reviewer can not run the verify
  command or git itself. Instead the harness runs the git commands the review prompt names
  (`reviewEvidence` in `review.ts`): log, `--stat` and patch of the current stretch and of a
  `base` task's earlier stretches, `git status --porcelain`, and `git diff HEAD` when there
  are uncommitted edits. Each output is written whole to its own file in
  `<dataDir>/evidence/<task id>/` (`current-diff.txt`, `earlier-1-diff.txt`, `status.txt`,
  ...), emptied before each review and removed with the task. The directory is passed as
  `SessionSpec.readableDirs`, which Gemini gets as `--include-directories`, so plan mode may
  read it; it is passed again when the reviewer is resumed. The prompt quotes outputs whole
  while they fit a shared 12,000 characters (`EVIDENCE_INLINE_LIMIT`) and names the file of
  every output, so deleted files, removed lines and earlier stretches stay reachable however
  large the change is. The limit keeps the prompt short enough to read; it is not needed for
  delivery, since the prompt goes on stdin. Gemini's read tools skip files git ignores, which
  includes `.harnessboard/notes.md`, so the rendered notes are also written to `notes.md` in
  that directory (`copyNotes` in `notes.ts`) and the prompt points the reviewer at the copy. `allowedTools` are Claude-style rules that Gemini
  does not understand, so they are not passed on.
- `stats` comes once, in the `result`, so no `context` events are emitted and Gemini manages
  its own context. Its per-model `input` (tokens not read from the cache) and `cached` become
  `input` and `cacheRead`.
- Gemini reports no subscription quota the way Claude Code's `rate_limit_event` does. A failed
  `result` whose message mentions quota, rate limits, `RESOURCE_EXHAUSTED` or 429 is reported
  with `apiErrorStatus: 429`; the task then waits `quotaRetryMinutes` and retries. Without an
  error in the `result`, the last `error` event with severity `error` supplies the message.
- Gemini CLI can not list its models, so the adapter has no `listModels` and model ids are
  typed.
- Tests drive `core/test/fixtures/fake-gemini.mjs`, which prints scripted stream-json lines.

## The Docker sandbox

A profile with `sandbox: 'docker'` and a `sandboxImage` gets its adapter wrapped in
`DockerSandbox` (`core/src/sandbox.ts`) by `createAdapter`. The wrapper is itself an
`AgentAdapter`: its `command` is `docker`, and its `buildArgs` is `docker run --rm -i`, the
mounts, the image, then the inner adapter's command and arguments. Parsing, stdin
encoding, capabilities, model lists and quota readings are the inner adapter's, so the
runner and the workflow do not know a session is sandboxed.

- **Mounts** are bind mounts at the same path as on the host, so every path in the CLI's
  arguments still works: the session's `cwd` (read-write; a reviewer's verify command may
  write build output), the git common directory when it lies outside `cwd`, as a
  worktree's does (`git rev-parse --git-common-dir`; read-only for `readOnly` sessions),
  the existing paths from the inner adapter's `configPaths(access)`, and `readableDirs`
  (read-only). Missing config paths are skipped, because docker would create them as
  root-owned folders. Gemini's `configPaths` includes the folder of its admin policy file
  for read-only sessions.
- **User:** `--user <uid>:<gid>` and `HOME` from the host, so the mounted login works and
  files stay the user's. `--init` forwards the stop signal the runner sends to the docker
  client (which proxies it) on to the agent. `--security-opt label=disable` makes the
  mounts usable on SELinux hosts without relabelling them.
- **Refusal:** `ensureReady()` (an optional adapter method) runs before a task's or chat's
  session is recorded. The sandbox rejects on Windows and when `docker version` can not
  reach a daemon, so the task fails with that reason and the agent never starts outside the
  container. `hb open` checks the same before it opens the session with `docker run -it`.
- `versionArgs` run the CLI's version command inside the image, so `hb agents` reports an
  image without the CLI.
- **Not covered:** environment variables (API keys, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
  `GEMINI_CLI_HOME`) are not passed in; the network is not restricted; the git directory
  holds every branch; Gemini's system-policy check looks at the host, not the image.
- Tests: `core/test/sandbox.test.ts` checks the exact command line and the refusal with an
  empty PATH, and runs a few containers (`alpine:3`) when a docker daemon answers on Linux;
  `core/test/harness-sandbox.test.ts` checks that a task fails without docker.

## Workspaces

A task's `workspace` says where its agents work. It is chosen when the task is created
(`CreateTaskInput.workspace`, `hb add --on-base`, the New task dialog) and never changes.

- **`worktree` (default):** the first start adds a worktree under the data directory, on a
  new branch from `baseRef`. The diff and commits are measured from `baseRef`. The branch is
  merged after review (`hb merge`), or left for the user with Mark done.
- **`base`:** `worktreePath` is set to the repository folder, `branch` stays null, and its
  commits land on `baseRef`, which must be checked out there. Everything that runs in
  `worktreePath` (sessions, the verify command, notes) needs no special case. Delete, merge
  and `hb open` do: they check `workspace` first, because that path is not theirs to remove.
- **One `base` task per folder:** a `base` task holds its folder while it is in one of
  `HOLDS_FOLDER` (`core/src/harness.ts`), review included, and while its session is still
  winding up. Queueing or chatting with another `base` task there, or merging into that
  branch, is refused while it does.
- **History of a `base` task:** with no branch of its own, its work is the stretches between
  the commit at the start of a session and the one at its end (`startCommit`, `endCommit`,
  `priorSpans`). Commits made by others while it let go of the folder fall between stretches
  and are left out of its diff, commits and review requests.

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
  device pairing and a passkey. M0 spike done, M1 not started.
