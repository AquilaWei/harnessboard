# Reasoning effort with model choice — progress

Goal: wherever a model is chosen in Harnessboard, the reasoning effort can be chosen too.

## Plan

Build in order; each feature is one session. See `feature_list.json` for acceptance steps.

| ID  | Feature                                                               | Status |
| --- | --------------------------------------------------------------------- | ------ |
| F1  | Shared types + catalogs list each model's effort levels               | done   |
| F2  | Adapters pass `effort` to the CLI (`--effort`, Codex `turn/start`)    | done   |
| F3  | Tasks store effort per role; harness and API use it                   | done   |
| F4  | Web board: effort selector next to every model picker (en + zh-TW)    | done   |
| F5  | CLI: `--*-effort` options, `hb models`, `hb agents --models`          | done   |
| F6  | Profile default effort (config, Settings, `hb agents --add --effort`) | done   |
| F7  | Docs, READMEs, CHANGELOG                                              | todo   |

Check command: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm format:check && pnpm test`
(ran green at planning time: 1377 tests passed, 14 skipped).

## What the next session should know

**Where the data comes from (verified 2026-10-09 on this machine):**

- Claude Code catalog `~/.claude/cache/model-catalog/*.json`, each model has
  `thinking: { type: "effort", effort_options: [{ id, name, badge?: { message }, tooltip? }] }`.
  Opus 5.5 offers `low, medium (badge "Recommended"), high, xhigh (name "Extra"), max (badge "3.5× or more usage")`.
  No explicit default field; use `null` for `defaultEffort` (or the "Recommended" one, decide in F1 and note it).
- `claude --help`: `--effort <level>` (low, medium, high, xhigh, max).
- `codex debug models` (codex-cli 0.162.0): per model `supported_reasoning_levels: [{ effort, description }]`
  and `default_reasoning_level`. Levels include `ultra` (see questions).
- Codex app-server: `TurnStartParams` has `effort` (and `model`); `ThreadStartParams` has no
  `effort`, so send it on `turn/start` only. Regenerate the schema with
  `codex app-server generate-json-schema --out <empty tmp dir>` if in doubt.
- Gemini adapter (`core/src/gemini.ts`) targets the sunset `gemini` CLI, which has no effort flag.
  Its successor `agy` has `--effort`, but the agy migration is separate work.

**Code map:**

- Types: `packages/shared/src/agents.ts` (`ModelInfo`, `TaskAgents`, `roleModel`, `isModelId`, `AgentProfile`).
- Catalog parsing: `packages/core/src/models.ts`; listing: `listModels()` in `claude-code.ts`, `codex.ts`.
- Session args: `SessionSpec` / `AgentCapabilities` in `packages/core/src/agent.ts`;
  `claude-code.ts` `buildArgs` (line ~55 pushes `--model`); `codex-app-server.ts` `turn/start` params.
- Harness builds the SessionSpec around `packages/core/src/harness.ts:1491` (`roleModel(...) ?? profile.model`).
- API: `packages/server/src/api.ts` `PUT /tasks/:id/agents` (model keys list) and task creation.
- CLI: `packages/server/src/task-options.ts` (`--*-model`), `packages/server/src/cli.ts` (`hb models`, `hb agents`).
- Web: `ModelPicker.tsx`, `AgentFields.tsx`, `TaskAgentsEditor.tsx`, `NewTaskDialog.tsx`, `SettingsDialog.tsx`, `i18n.ts`.
- Loop mode uses the same `TaskAgents`, so it gets effort for free once F3/F5 are done.

**Conventions:** follow the `coding-standards` skill (one-line English commits `<type>: ...`,
feature and its tests in one commit, i18n en + zh-TW). Do not bump the version inside a
feature; after all features pass, a PATCH test build first, MINOR only after the user's
real-machine acceptance.

**Needs real-machine acceptance (cannot be automated):** a real Claude session started with
`--effort` actually runs at that effort (check the session's `init`/status), and a real Codex
turn with `effort` is accepted by the app-server. Spend real runs sparingly.

## Session log

- **F1 (done):** `EffortInfo`, `ModelInfo.efforts` / `defaultEffort`, `isEffortId`, `roleEffort`
  and the five `*Effort` fields on `TaskAgents` are in `packages/shared/src/agents.ts`.
  `parseClaudeCatalog` reads `thinking.effort_options` (name from `name`, description from
  `tooltip.content`, note from `badge.message`); `parseCodexModels` reads
  `supported_reasoning_levels` (name = id, since Codex gives no display name) and
  `default_reasoning_level`. Decision: Claude's `defaultEffort` stays `null`; the
  "Recommended" badge is still visible as the effort's note, but it is not proof of what the
  CLI uses without `--effort`, so F4's "Default" option should not claim a level for Claude.
  Verify: 1396 passed, 14 skipped.
- **F2 (done):** `SessionSpec.effort: string | null` and `AgentCapabilities.effort` in
  `packages/core/src/agent.ts`. Claude Code pushes `--effort <level>` right after `--model`;
  Codex sends `effort` only on `turn/start` (new and resumed threads), never on
  `thread/start` / `thread/resume`; Gemini reports `effort: false` and ignores it. The Docker
  sandbox needed no code: it already hands the whole spec to the inner adapter's `buildArgs`
  and `createConnection`, and its `capabilities` are the inner one's; tests now pin that.
  The harness passes `effort: null` with a `TODO: F3` comment at the SessionSpec in
  `harness.ts`; F3 replaces it with `roleEffort(...)` and removes the TODO.
  `docs/architecture.md`'s capability table is left for F7.
  Verify: 1409 passed, 14 skipped.
- **F3 (done):** `CreateTaskInput` and `AgentsUpdate` (`packages/shared/src/views.ts`) take the
  five `*Effort` fields; `createTask` and `setAgents` validate them with `effortOrNull`
  (`isEffortId`, trimmed, empty → `null`) and the API's `PUT /tasks/:id/agents` passes them
  through (an invalid one throws, so the API answers 400 and nothing is saved). The harness
  now sets `SessionSpec.effort` to `roleEffort(task.agents, role)`; the F2 TODO is gone.
  `setAgents` walks a `ROLE_MODEL_EFFORT` table: a role's effort is cleared only when its
  model actually changes (sending the same model again keeps it, so F4's editor can send
  every field), and an effort in the same update wins. Changing a role's _agent_ (profile)
  does not clear its effort; the web/CLI send the model with it anyway. Old tasks without
  effort keys run with no `--effort` (tested by overwriting the stored agents).
  Verify: 1424 passed, 14 skipped.
- **F4 (done):** `ModelPicker` now renders a second field, "Reasoning effort", after the model
  select, and its `onChange` takes `(model, effort)`. The options come from the _effective_
  model: the chosen one, or the profile's own `model` when "Profile default" is kept (hidden
  when the profile names no model or the id is typed by hand). Switching model keeps the
  effort only when the new model offers it; picking "Other model id…" clears it. "Default"
  shows `Default (<name>)` only when `defaultEffort` is known (so never for Claude). Effort
  names get their first letter raised (Codex names are lowercase ids); the effort's
  description goes in the option's `title`. `AgentFields`/`AgentChoice` carry the five
  `*Effort` fields and a profile change resets them; `NewTaskDialog` sends them (null for an
  unused role) and `TaskAgentsEditor` sends them and shows `· High` after the model in its
  summary (the stored id with its first letter raised, since the summary has no model list:
  `xhigh` shows as `Xhigh`, not `Extra`). Hiding for Gemini: `Harness.models` now drops
  `efforts`/`defaultEffort` when the adapter's `capabilities.effort` is false, so the board
  needs no capability field in the API. Tests: `packages/web/test/effort.test.tsx`, one new
  case in `core/test/models.test.ts`.
  Verify: 1440 passed, 14 skipped.
- **F5 (done):** `hb add` / `hb loop` take `--effort`, `--spec-effort`, `--designer-effort`,
  `--tester-effort`, `--reviewer-effort` (`withTaskOptions` / `taskInput`); the server
  validates them, as with models. `hb models`' options moved into `withAgentOptions` and its
  request into `agentsUpdate` (both in `task-options.ts`) so they can be tested; it takes the
  same five effort options, `default` sends `null`. Its output is `formatTaskAgents` and
  `hb agents --models` uses `formatModel` (both in `format.ts`): an unset effort shows
  `(default effort)`, and a model with efforts gets an indented `efforts: low, medium, …` line
  of the ids `--effort` takes, plus `(default medium)` when the CLI names a default. Models
  without efforts print only their line (trailing spaces now trimmed).
  Verify: 1453 passed, 14 skipped.
  Review fix: the `hb models` spec line now always shows the model and effort its sessions
  run with (`roleModel` / `roleEffort` from shared, the same resolution the harness uses),
  after the profile or `(the implementer)`, so `--spec-effort max` without a spec profile
  is no longer hidden. Verify: 1455 passed, 14 skipped.
- **F6 (done):** `AgentProfile.effort?: string` and `NewAgentProfile.effort?: string | null`
  (`packages/shared/src/agents.ts`); `validate` in `config.ts` rejects an effort that is not
  an `isEffortId`, naming `config agents.<id>.effort`. `addAgent` takes `effort`; the new
  `Harness.setAgentEffort(id, { effort })` (API `PUT /agents/:id/effort`) sets or removes it
  and saves it with `saveUserAgentEffort`, which keeps the file's own keys of that profile
  (or writes the profile in effect when the file has none, e.g. the default `claude`).
  Session effort is `sessionEffort` in `harness.ts`: the task's role effort, else the
  profile's effort **only while the session runs the profile's own model** (a task that
  picks another model gets no `--effort`, since that model may not offer the level, the
  same reasoning as F3 clearing an effort on model change), else none.
  Settings: an "Reasoning effort" column in the agents table; `EffortSelect` was pulled
  out of `ModelPicker` and is used for both. It shows a select only when the profile names
  a model whose listed efforts are non-empty; otherwise the stored effort (or "Default") as
  text. Changes are sent with Save, before the settings. CLI: `hb agents` options moved to
  `withProfileOptions` and the add body to `profileInput` (`task-options.ts`), with
  `--effort`. Not done (not in the steps): `hb agents` listing does not show the effort,
  and the task pickers' "Default" option does not name the profile's effort.
  Verify: 1478 passed, 14 skipped.
  Review fixes: (1) `sessionEffort` drops the "own model only" rule; it is now role effort,
  else profile effort, else none, whatever model the task picks (doc comment on
  `AgentProfile.effort` and the Settings hint updated). (2) The task pickers' "Default"
  option names the profile's effort when it has one, else the model's default. (3)
  `saveUserAgentEffort` writes a profile the file lacks from `defaultAgents()` (the built-in
  profiles) instead of the one in effect, so `HARNESSBOARD_MODEL` / `HARNESSBOARD_CLAUDE_PATH`
  are never saved. Regression tests for all three fail on the old code.
  Verify: 1481 passed, 14 skipped.
  Second review fix: `EffortSelect` lists a stored effort the model does not offer as its
  own option ("Max (not offered by this model)") and selects it, instead of showing
  "Default" while that effort is still sent; choosing Default then clears it. Regression
  tests in `settings-effort.test.tsx` fail on the old code.
  Verify: 1483 passed, 14 skipped.
- **F7 (done):** docs only. `docs/cli.md`: a "Choosing models and reasoning effort" section
  with a role → option table (all five `--*-effort` options), `hb agents --models` levels,
  `hb models` output and `default`, and the model-change rule. `docs/configuration.md`: a
  profile with `"effort"`, who honours it (Claude Code `--effort`, Codex turn effort; not
  Gemini), the role → profile → none order, how to set it. `docs/architecture.md`: an
  `effort` row in the capability table and a per-adapter table (`--effort`,
  `turn/start.effort`, Gemini not passed, Docker forwards). `docs/web-board.md`: the effort
  select and the Settings column. READMEs: one "Why use it" bullet and the Go-further row,
  in both languages. CHANGELOG: an `Unreleased` entry; version unchanged.
  Verify: 1483 passed, 14 skipped.

## Open questions

See `questions` in `feature_list.json`. The plan assumes the recommended answers; if the
user picks "per task only", drop F6.
