# Contributing to Harnessboard

Thanks for helping. This page covers how to set up, what a good change looks like, and how
to get it merged.

## Set up

```bash
git clone <your fork> && cd harnessboard
corepack enable          # provides the pnpm version pinned in package.json
pnpm install
pnpm build
pnpm test                # uses a fake claude CLI; no account or network needed
```

You need **Node.js ≥ 22.13** (see `.nvmrc`) and **Git**. A signed-in
[Claude Code](https://docs.claude.com/en/docs/claude-code) is only needed for manual
end-to-end runs.

## Layout

| Package           | What it holds                                                          |
| ----------------- | ---------------------------------------------------------------------- |
| `packages/shared` | Types and pure helpers used by every other package                     |
| `packages/core`   | Runner, scheduler, loop mode, worktrees and the SQLite store           |
| `packages/server` | `hb` CLI, HTTP API and static file server; published as `harnessboard` |
| `packages/web`    | React web board, bundled into the server package at build time         |
| `android`         | Android app that opens the board (Kotlin, Gradle)                      |

The format of Claude Code's headless output, which the runner depends on, is described in
[docs/stream-json-notes.md](docs/stream-json-notes.md).

## Android app

The app in `android/` needs:

- **JDK 17 or newer** to run Gradle (tested with JDK 25). The Kotlin code compiles with a JDK 21
  toolchain, which Gradle downloads by itself when it is not installed.
- **Android SDK** with platform 37 (`android-37.0`) and a recent build-tools, e.g. from
  [Android Studio](https://developer.android.com/studio) or the command-line tools. Point
  `ANDROID_HOME` at it, or install it in the default place (`~/Android/Sdk` on Linux,
  `~/Library/Android/sdk` on macOS, `%LOCALAPPDATA%\Android\Sdk` on Windows).

```bash
pnpm android:check       # build-script tests, ktlint, unit tests, Android lint and a debug APK
```

The debug APK ends up in `android/app/build/outputs/apk/debug/app-debug.apk`. The first run
downloads Gradle and the dependencies; later runs work offline. On a machine without the SDK,
`HARNESSBOARD_SKIP_ANDROID=1 pnpm android:check` skips it. The app's version is read from
`packages/server/package.json`; do not set one in Gradle. `android/buildSrc` holds the
build-script code that has tests, such as the version-code formula and the release signing
(`ReleaseSigning`, read only from the `HB_ANDROID_*` variables; see [docs/development.md](docs/development.md)).

## Making a change

- **Tests come with the change.** A new feature needs tests. A bug fix needs a regression
  test, and you should check that it fails without the fix.
- **Tests stay simple.** One behaviour per test, a name that says what is expected, and
  expected values written out rather than computed.
- **Agent behaviour is tested with the fake CLI.** `packages/core/test/fixtures/fake-claude.mjs`
  plays scripted stream-json sessions. Do not add fixtures recorded from real sessions
  unless paths, accounts and conversation content are removed.
- **Cross-platform:** it must work on Linux, macOS and Windows. Use `cross-spawn` and
  `tree-kill` for processes, `path.join` for paths, and no shell-specific syntax outside
  the user's own verify command.
- **Before you push:** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`.
  CI runs the same checks on all three platforms.
- **Docs:** if you change a command, option, environment variable or install step, update
  the matching page under `docs/` (and `README.md` and `README.zh-TW.md` if the quick start
  changes) in the same commit. Add a line under _Unreleased_ in
  `CHANGELOG.md` for anything users will notice.
- **Web dependencies:** after adding or updating a package in `packages/web`, run
  `node scripts/third-party-notices.mjs` and commit the updated `THIRD-PARTY-NOTICES.md`.

## Commits

One change per commit, with a one-line English message:

```
<type>: <description>
```

`type` is one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`.
A feature and its tests go in the same commit.

## Versions

Versions follow `MAJOR.MINOR.PATCH`. The version lives only in `packages/server/package.json`.
New features are released as PATCH test versions first. MINOR goes up once a feature has
been accepted on real machines. Every release updates `CHANGELOG.md` and gets a `vX.Y.Z` tag.

## License

By contributing you agree that your work is licensed under [Apache-2.0](LICENSE).
