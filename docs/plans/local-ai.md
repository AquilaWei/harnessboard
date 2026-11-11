# Local AI helpers

What a local model (through LocalAICLI, `localai run --json`) can do
for Harnessboard, in priority order. Local AI is an **optional helper**: it is off by default,
a missing binary means "unavailable", and no Harnessboard flow may fail because of it.

## Constraints that shape every item

- `localai run --json --model NAME` handles **one request per process** and has **no tool
  calls**. Output is NDJSON v1 (start, delta\*, usage, then one done or error). Requests are
  run one at a time so models do not compete for RAM or ports.
- Decode speed from the LocalAICLI reports: about **50 tok/s** for mellum2.1, about **47** for
  lfm2.5 and about **23** for gpt-oss-20b.
- Vulkan prompt processing is slow (about **100–200 tok/s**), so **keep inputs short**: a
  2,000-token prompt costs 10–20 s before the first output token.
- Small models can be confidently wrong. Output is data to validate, never to trust, and
  anything that lands in the repository is shown to a human first.

## Built

All requests go through one queue in the server and run one at a time. The board header shows
a **Local AI** status chip (Disabled / Binary missing / Idle / Running with use case, model and
queue length; expanded: the model of each use case and the last error).

### 1. Price-table refresh (Codex and Claude)

- **Approach:** the server fetches the provider's official pricing page, reduces the HTML to
  the relevant text, asks local AI to extract JSON and validates it strictly (schema, bounds,
  cached ≤ input, the provider's model-id pattern). Results go to the user `prices.json`, which
  is looked up before the bundled tables. Providers are a registry entry each (URLs, model-id
  pattern); `codex` and `claude` exist today.
- **Automatic refresh:** an estimate that meets a model without a price triggers a background
  refresh of that provider, at most once per 24 hours per provider (the attempt time is saved
  in `prices.json`, so failed attempts count). Results are logged as events and later
  estimates use them at once. Claude Code's reported `costUSD` is preferred when present.
- **Manual refresh:** `hb pricing refresh [--provider codex|claude] [--yes]` asks the running
  server for a preview, prints the diff and writes only after confirmation.
- **Model:** `gpt-oss-20b`. Accuracy matters more than speed: a wrong price silently skews every
  cost estimate.
- **Latency:** about 1–2 KB of reduced text (≈ 500–1,000 tokens) is 5–10 s of prompt processing;
  a 13-model table is ≈ 400 output tokens, about 20 s at 23 tok/s plus reasoning tokens. Expect
  **30–90 s** end to end.
- **Risks:** hallucinated or misread numbers (mitigated by validation, and by the diff and
  confirmation for manual refreshes; automatic refreshes rely on validation alone); page layout
  changes (extraction fails, nothing is written); reasoning tokens inflating latency; the
  pricing page changing its URL.

### 2. Task branch slug and English title

- **Approach:** `branchName` in `packages/core/src/worktree.ts` strips everything outside
  `a-z0-9`, so a Chinese title becomes an empty slug. In that case local AI is asked for an
  English title (≤ 80 characters) and a slug validated against `^[a-z0-9-]{1,30}$`; the branch
  is `hb/<id>-<slug>` and the original title is kept.
- **Model:** `mellum2.1`: short input, short output, fastest decode.
- **Latency:** about 20 prompt tokens and 8 output tokens, so **1–3 s** plus model load time
  on a cold start. A 6 s deadline that includes queue wait keeps task creation from waiting.
- **Risks:** cold-start model load exceeding the deadline; non-deterministic names; a bad slug
  (validation rejects it). **Fallback:** the previous behaviour (`hb/<id>` or the ASCII slug).

### 3. Integration commit-message and CHANGELOG drafts

- **Approach:** when delegated work is integrated, local AI gets the work goal and the changed
  file list (not the diff) and drafts a `<type>: <description>` commit message and a
  user-facing CHANGELOG bullet. The commit message is used only if it is English and matches
  `^(feat|fix|docs|style|refactor|perf|test|chore): [^\n]{1,72}$`; otherwise the usual
  `feat: integrate delegated work <id>` is kept. The CHANGELOG draft is only attached to the
  integration result, never written to a file.
- **Model:** `lfm2.5`, with the same 6 s deadline.
- **Latency:** a 300-token input is about 3 s of prompt processing and about 30 tokens of output,
  so **4–8 s**.
- **Risks:** summaries that describe implementation instead of user effect, wrong type
  (`feat` vs `fix`), invented details. The CHANGELOG bullet is a draft only; the author edits it.

## Documented only (not built yet)

### 4. Draft en→zh-TW i18n strings

- **Approach:** translate new English UI strings into zh-TW as a draft for the existing
  catalogs; a human reviews every string before it is committed.
- **Model:** `lfm2.5`.
- **Latency:** batches of 20–30 strings are about 600 tokens of output, about **15–30 s**.
- **Risks:** wrong terminology or tone, lost placeholders such as `{id}` (check placeholders
  mechanically), mixed Simplified/Traditional characters. Never merged without review.

## Not suitable for local AI

| Item                    | Why not                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission approval     | A wrong "allow" runs unreviewed commands. It needs reliable judgment and structured tool context; a small local model's error rate is unacceptable. |
| Risk classification     | Safety decisions must be deterministic and auditable; a probabilistic model's false negatives are unsafe.                                           |
| PM secretary            | It needs tool calls (task status, dispatch, answers); `localai` has none, and one request per process cannot hold a session.                        |
| Acceptance              | Verifying that work meets the criteria needs the repository and test results (tools) and strong reasoning; a missed defect ships.                   |
| Main-flow summarisation | Long inputs hit the slow Vulkan prompt processing (minutes), and summaries sit on the critical path and are trusted by the PM and user.             |
