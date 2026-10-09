# Reasoning effort with model choice — progress

Goal: wherever a model is chosen in Harnessboard, the reasoning effort can be chosen too.

## Plan

Build in order; each feature is one session. See `feature_list.json` for acceptance steps.

| ID  | Feature                                                               | Status |
| --- | --------------------------------------------------------------------- | ------ |
| F1  | Shared types + catalogs list each model's effort levels               | done   |
| F2  | Adapters pass `effort` to the CLI (`--effort`, Codex `turn/start`)    | todo   |
| F3  | Tasks store effort per role; harness and API use it                   | todo   |
| F4  | Web board: effort selector next to every model picker (en + zh-TW)    | todo   |
| F5  | CLI: `--*-effort` options, `hb models`, `hb agents --models`          | todo   |
| F6  | Profile default effort (config, Settings, `hb agents --add --effort`) | todo   |
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

## Open questions

See `questions` in `feature_list.json`. The plan assumes the recommended answers; if the
user picks "per task only", drop F6.
