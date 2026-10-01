# Claude Code stream-json notes

Observed with Claude Code 2.1.284 (`claude -p --output-format stream-json --verbose`),
subscription (OAuth) login, no API key. Re-verify when upgrading Claude Code.

## Authentication

- Headless `-p` works with a subscription login. `system/init.apiKeySource` is `"none"`.
- `--bare` must not be used: it only reads `ANTHROPIC_API_KEY`.

## Event types seen

| type               | subtype            | notes                                                                                                              |
| ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `system`           | `init`             | `session_id`, `model`, `permissionMode`, `claude_code_version`; emitted again after each turn and after compaction |
| `system`           | `thinking_tokens`  | progress estimate, safe to ignore                                                                                  |
| `system`           | `status`           | `{"status":"compacting"}` then `{"status":null}`                                                                   |
| `system`           | `compact_boundary` | `compact_metadata: {trigger, pre_tokens, post_tokens, duration_ms}`                                                |
| `assistant`        | –                  | `message.usage` per API call; `message.content[]` blocks (`thinking`, `text`, `tool_use`)                          |
| `user`             | –                  | tool results and replayed messages                                                                                 |
| `rate_limit_event` | –                  | subscription quota, see below                                                                                      |
| `result`           | `success` / error  | end of one turn; `usage`, `modelUsage`, `is_error`, `api_error_status`, `result`                                   |

## Context size

- Current context = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
  from the latest `assistant.message.usage`.
- Window size: `result.modelUsage[<model>].contextWindow` (1,000,000 for the default model
  on this account). Only available after the first turn, so the window must be configurable
  and cached per model.
- A fresh session already uses ~20–25k tokens (system prompt, tools, CLAUDE.md, skills).

## Subscription quota

`rate_limit_event.rate_limit_info`:

```json
{
  "status": "allowed",
  "resetsAt": 1790718000,
  "rateLimitType": "five_hour",
  "unifiedWindows": {
    "five_hour": { "utilization": 0.5, "resetsAt": 1790718000 },
    "seven_day": { "utilization": 0.63, "resetsAt": 1790812800 }
  }
}
```

- `utilization` and `resetsAt` (unix seconds) allow pausing _before_ the limit is hit.
- Not yet observed: the payload when the limit is reached. Assumed: `status` other than
  `"allowed"` and/or `result.is_error` with `api_error_status` 429. Detection must accept both
  and fall back to polling every 15 minutes.

## Multi-turn input (`--input-format stream-json`)

- One JSON line per user message on stdin:
  `{"type":"user","message":{"role":"user","content":"..."}}`
- Each message produces its own `result`. The process exits when stdin closes.
- Sending `/compact <instructions>` as a message works: `status: compacting`,
  then `compact_boundary` (manual trigger; 21,686 → 2,693 tokens in the test).

## Session identity

- `--session-id <uuid>` fixes the id up front.
- `--resume <uuid>` keeps the same id and the full history.

## Messages sent during a turn

A user message written to stdin while a turn is still running is injected into that turn:
the agent sees it at the next tool-result boundary and acts on it (the test asked it to stop
after the current command, and it did, producing a single `result`). This is how the soft
context threshold asks the agent to wrap up without waiting for the turn to end.

## Permission prompts (`--permission-prompt-tool stdio`)

Checked with Claude Code 2.1.285.

- Without the flag, `-p` refuses every tool that the rules do not allow. The refusal shows up
  as a tool result ("This command requires approval"), and the `result` line lists it under
  `permission_denials`.
- With the flag, the CLI prints a control request and waits, with the process still
  running, until it gets an answer:
  `{"type":"control_request","request_id":"<id>","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"git add a.txt"},"permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"git add *"}],"behavior":"allow","destination":"localSettings"}],"tool_use_id":"toolu_…"}}`
- The answer is one line on stdin:
  `{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"behavior":"allow","updatedInput":<the request's input>}}}`.
  To deny, send `{"behavior":"deny","message":"why"}` instead. The agent sees the message
  and carries on.
- No `initialize` control request is needed first.
- A suggested rule such as `git add *` corresponds to the rule `Bash(git add *)`.

## Compacting (`/compact`)

Verified with Claude Code 2.1.286 in `-p --input-format stream-json` mode:

- A `/compact` user message runs as a turn of its own. It prints a `system` line with
  `subtype: "compact_boundary"` and `compact_metadata.pre_tokens` / `post_tokens`, then a
  `result` with an empty `result`. The conversation then continues in the same process.
- Sent while a turn is running, `/compact` waits until that turn has ended; plain messages
  are read at the next tool boundary instead.
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` did not make print mode compact, within or between turns.
- Harnessboard therefore sends `/compact` after a turn that ended past the compact threshold,
  and never interrupts work for it.
