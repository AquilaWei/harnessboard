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

## Built in this round

### 1. Codex price-table refresh (adapter + pilot command)

- **Approach:** `hb pricing refresh` fetches the official pricing pages, reduces the HTML to
  the relevant text, asks local AI to extract JSON, validates it strictly (schema, bounds,
  cached ≤ input, model-id pattern), prints a diff and writes only after confirmation.
- **Model:** `gpt-oss-20b`. Accuracy matters more than speed: a wrong price silently skews every
  cost estimate.
- **Latency:** about 1–2 KB of reduced text (≈ 500–1,000 tokens) is 5–10 s of prompt processing;
  a 13-model table is ≈ 400 output tokens, about 20 s at 23 tok/s plus reasoning tokens. Expect
  **30–90 s** end to end.
- **Risks:** hallucinated or misread numbers (mitigated by validation, the diff and mandatory
  confirmation); page layout changes (extraction returns nothing, nothing is written);
  reasoning tokens inflating latency; the pricing page changing its URL.

## Documented only (not built yet)

### 2. Task branch slug

- **Approach:** `branchName` in `packages/core/src/worktree.ts` strips everything outside
  `a-z0-9`, so a Chinese title becomes an empty slug and the branch is just `hb/<id>`. Ask local
  AI for a 2–4 word English kebab-case slug from the title, validate against `^[a-z0-9-]{1,30}$`.
- **Model:** `mellum2.1`: short input, short output, fastest decode.
- **Latency:** about 20 prompt tokens and 8 output tokens, so **1–3 s** plus model load time
  on a cold start; must not delay task creation (run it with a short timeout).
- **Risks:** cold-start model load dominating the latency; non-deterministic names; a bad slug
  (validation rejects it). **Fallback:** the current behaviour (`hb/<id>` or the ASCII slug).

### 3. Draft en→zh-TW i18n strings

- **Approach:** translate new English UI strings into zh-TW as a draft for the existing
  catalogs; a human reviews every string before it is committed.
- **Model:** `lfm2.5`.
- **Latency:** batches of 20–30 strings are about 600 tokens of output, about **15–30 s**.
- **Risks:** wrong terminology or tone, lost placeholders such as `{id}` (check placeholders
  mechanically), mixed Simplified/Traditional characters. Never merged without review.

### 4. Commit-message and CHANGELOG drafts

- **Approach:** feed the diff stat and file list (not the full diff) and ask for a one-line
  `<type>: <description>` commit message or a user-facing CHANGELOG bullet.
- **Model:** `lfm2.5`.
- **Latency:** a 300-token input is about 3 s of prompt processing and about 30 tokens of output,
  so **4–8 s**. Long diffs are too slow on Vulkan and must be truncated.
- **Risks:** summaries that describe implementation instead of user effect, wrong type
  (`feat` vs `fix`), invented details. A draft only; the author edits it.

## Not suitable for local AI

| Item                    | Why not                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission approval     | A wrong "allow" runs unreviewed commands. It needs reliable judgment and structured tool context; a small local model's error rate is unacceptable. |
| Risk classification     | Safety decisions must be deterministic and auditable; a probabilistic model's false negatives are unsafe.                                           |
| PM secretary            | It needs tool calls (task status, dispatch, answers); `localai` has none, and one request per process cannot hold a session.                        |
| Acceptance              | Verifying that work meets the criteria needs the repository and test results (tools) and strong reasoning; a missed defect ships.                   |
| Main-flow summarisation | Long inputs hit the slow Vulkan prompt processing (minutes), and summaries sit on the critical path and are trusted by the PM and user.             |
