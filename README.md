# Harnessboard

**A local harness and task board for running Claude Code agents.** Each task runs headless
`claude` in its own git worktree. Harnessboard keeps every session's context small by handing
work off to a fresh session, and it pauses when your subscription quota runs low.

> **Status: early development.** The core runner works; the CLI and web UI are in progress.

## Why

- **Small contexts:** at a soft threshold (30–50 % of the window, depending on task size),
  the agent is asked to commit and write a handoff note. The next session then starts fresh
  from that note.
- **Parallel and isolated:** one git worktree and branch per task, so you review a diff
  instead of a mess.
- **Quota-aware:** it reads the usage the CLI reports, stops starting sessions near the limit,
  and resumes automatically after the reset.
- **Uses your existing login:** it drives the `claude` CLI you are already signed in to.
  No API key is needed.

## Requirements

- Node.js ≥ 22.13 (see `.nvmrc`)
- Git
- [Claude Code](https://docs.claude.com/en/docs/claude-code), signed in
- Linux, macOS or Windows (on Windows, Claude Code needs Git for Windows)

## Development

```bash
corepack enable        # provides the pinned pnpm version
pnpm install
pnpm test              # uses a fake claude CLI; no account needed
pnpm lint && pnpm typecheck
```

Notes on the Claude Code output format that Harnessboard relies on are in
[docs/stream-json-notes.md](docs/stream-json-notes.md).

## License

[Apache-2.0](LICENSE). Harnessboard is an independent project and is not affiliated with
Anthropic.
