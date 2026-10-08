# Desktop app

Prefer an app to a terminal? The desktop app starts the server for you and shows the board
in its own window. **Click the icon and the board is there.**

- **Build it yourself:** no prebuilt installers are published at the moment. See
  [Building the installers](#building-the-installers) below; a built AppImage needs
  `chmod +x` before it runs.
- **Builds:** .deb (Debian, Ubuntu), .rpm (Fedora, openSUSE) and AppImage (any distribution)
  on Linux, .dmg (Intel and Apple silicon) on macOS, an
  installer (.exe) on Windows.
- **Still needed:** git and the agent CLIs (`claude`, `codex`, `gemini`). The app finds them the way
  your terminal does, including `~/.local/bin`, nvm and Homebrew.
- **Closing the window keeps it running** in the tray / menu bar, so tasks go on. Use
  **Quit Harnessboard** there to stop it; running agents are stopped cleanly. On a desktop
  without a tray (plain GNOME), launch the app again to bring the window back.
- **Works with `hb`:** if `hb serve` is already running, the app shows that server instead
  of starting a second one. The `hb` commands work against the app's server too.
- **Server log:** `<data folder>/logs/desktop-server.log`.
- **Not signed yet.** The first time you open it:
  - **macOS:** right-click the app → **Open** → **Open** (or System Settings → Privacy &
    Security → **Open Anyway**).
  - **Windows:** on the SmartScreen notice, **More info** → **Run anyway**.

## Building the installers

Each OS builds only its own installers: a .dmg needs a Mac, an .exe needs Windows. CI runs
the same steps on all three for every version tag. The files land in
**`packages/desktop/release/`**, named after the version (`Harnessboard-0.0.19-…`).

**Every OS first needs:** Node.js ≥ 22.13, Git, and a clone of this repository. If
`corepack` is missing (it is no longer bundled from Node 25 on), install it with
`npm install --global corepack@latest`. After pulling changes, run `pnpm build` again before
`dist`: it packages what the last build produced. The first `dist` downloads Electron
(~100 MB).

### Linux: Ubuntu / Debian

```bash
corepack enable
pnpm install && pnpm build
pnpm --filter @harnessboard/desktop dist --linux deb AppImage   # → .deb and .AppImage
V=$(node -p "require('./packages/server/package.json').version")
sudo apt install ./packages/desktop/release/Harnessboard-$V-linux-amd64.deb
```

- **Use the .deb here.** It adds Harnessboard to the app menu and installs what it needs.
- The AppImage needs `libfuse2` (`libfuse2t64` on 24.04). On 24.04 it may also be stopped by
  the AppArmor sandbox rules, which the .deb is not.

### Linux: Fedora

```bash
sudo dnf install rpm-build libxcrypt-compat   # rpmbuild, and libcrypt.so.1 for the fpm tool
corepack enable
pnpm install && pnpm build
pnpm --filter @harnessboard/desktop dist --linux rpm      # → .rpm
V=$(node -p "require('./packages/server/package.json').version")
sudo dnf install ./packages/desktop/release/Harnessboard-$V-linux-x86_64.rpm
```

- Harnessboard is then in the app menu. Remove it with `sudo dnf remove Harnessboard`; your
  tasks stay in the data folder.
- Without `libxcrypt-compat` the build stops with
  `libcrypt.so.1: cannot open shared object file`: the `fpm` tool electron-builder downloads
  needs it. `--linux AppImage` builds without it.
- **Why not Flatpak?** Harnessboard runs `claude`, `codex`, git and your projects' own tools.
  Flatpak's sandbox hides all of them from the app, so it would have to leave the sandbox for
  every command anyway.

### macOS

```bash
xcode-select --install                        # Git and the build tools, if not installed yet
corepack enable
pnpm install && pnpm build
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @harnessboard/desktop dist   # → two .dmg
V=$(node -p "require('./packages/server/package.json').version")
open packages/desktop/release/Harnessboard-$V-mac-arm64.dmg   # Apple silicon; -mac-x64 for Intel
```

- Drag **Harnessboard** to **Applications**.
- `CSC_IDENTITY_AUTO_DISCOVERY=false` keeps electron-builder from signing with a developer
  certificate it finds in your keychain; the build is signed ad hoc, as the released one is.

### Windows

In PowerShell, with [Git for Windows](https://git-scm.com/download/win) installed:

```powershell
corepack enable                               # run PowerShell as administrator for this line
pnpm install; pnpm build
pnpm --filter @harnessboard/desktop dist      # → .exe installer
$V = node -p "require('./packages/server/package.json').version"
.\packages\desktop\release\Harnessboard-$V-win-x64.exe
```

- `corepack enable` writes into the Node.js folder, so it needs an administrator
  PowerShell once; the other lines do not.
- The installer installs for your user only and lets you pick the folder.

Only the Fedora steps have been run on a real machine so far (building the .rpm). The Ubuntu, macOS and Windows
steps are what CI runs.
