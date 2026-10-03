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

## Agents, profiles and roles

- **Provider:** an agent CLI Harnessboard knows how to drive. Today there are two,
  `claude-code` and `codex`. Each provider has one `AgentAdapter`.
- **Profile:** a named way to run a provider, set in the user config. It holds a command,
  a model, and optionally a context window. `claude` always exists. Adding a second profile
  (for example the same CLI with another model) needs no code.
- **Role:** what a session is asked to do.
  - `spec`: agrees acceptance criteria with the user before anything is built. It runs
    read-only. `task.agents.spec` is optional; without it the implementer plays this role.
    When the same agent plays both roles the approved discussion is resumed with edit access;
    otherwise the implementer starts a new session from the approved criteria.
  - `design`: optional, single tasks only. After the spec is settled, one read-only session
    writes a design note, stored as the `design` event. `Workflow.goal()` adds the note to
    the prompts of the implementer and the reviewer. It has no human gate, and it runs once;
    the implementer then starts a new session, never a continuation of the designer's.
  - `implementer`: edits files and commits.
  - `reviewer`: checks the implementer's latest step. It runs read-only and must answer
    with `VERDICT: APPROVE` or `VERDICT: CHANGES`.

  A task names a profile for each role (`task.agents`).

The reviewer loop lives in `core/src/workflow.ts`:

```
implementer step done ──► review_request ──► reviewer session (read-only)
        ▲                                         │
        │ changes (≤ maxReviewRounds)             ├─ APPROVE  → next feature / Review
        └─────────────────────────────────────────┤─ CHANGES  → feedback to implementer
                                                  └─ no verdict, over the round limit,
                                                     or files changed → a human
```

A step counts as done when a single task's session completes, or when the harness has
verified a loop feature. `review_request` and `review` are events in the store, so a
restart picks up exactly where the task was.

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
