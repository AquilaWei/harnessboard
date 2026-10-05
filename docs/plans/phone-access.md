# Phone access

Status: planned, not started. Decisions dated 2026-10-04.

## Goal

Use Harnessboard from a phone, from anywhere, for four things:

- receive notifications;
- approve and answer;
- follow progress;
- create tasks.

The computer keeps running the server (desktop app or `hb serve`). The phone opens the same web board.

## Decisions

- **Connection: Tailscale.**
  - The server stays bound to `127.0.0.1`. The user runs `tailscale serve --bg <port>` once, which
    serves `https://<machine>.<tailnet>.ts.net` and proxies it to the local port.
  - Harnessboard does not depend on Tailscale. It only knows "allowed remote hosts" and "paired
    devices", so any HTTPS reverse proxy works.
  - Rejected options:
    - LAN only: no HTTPS, no push, home only.
    - Public tunnel: exposes an API that runs commands.
    - Chat bot: limited to predefined actions.
- **Second factor: passkey (WebAuthn)** on the phone, using face, fingerprint or screen lock.
  No TOTP and no backup codes; a lost phone is revoked and re-paired from the computer.
- **When to verify:**
  - the board is opened, or has been idle for 30 minutes;
  - sensitive actions, when the last verification is older than 5 minutes.
- **Local (loopback) use is unchanged.** It never needs pairing or a passkey.
- **No one-click `tailscale serve` from the app.** The app shows the command to copy.

## Threat model

| Who                                             | Stopped by                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Anyone on the internet                          | Not reachable: Tailscale only.                                                                        |
| Another device in the tailnet, or a shared node | Device pairing: a cookie from a QR code shown on the computer.                                        |
| Someone holding the unlocked phone              | Passkey, on opening the board and again for sensitive actions.                                        |
| A malicious website the phone visits            | `SameSite=Strict` cookie, the `x-harnessboard-client` header on non-GET requests, and the Host check. |

Recommended Tailscale settings, which go in the README:

- 2FA on the login account;
- device approval;
- an ACL that only lets the user's phone reach this machine.

## Milestones

Each milestone is its own set of commits. Release after M2 (the secure baseline), then after M3,
then after M4.

### M0 — Spike (no code merged)

- **Highest risk, check first.** What Host and forwarding headers does `tailscale serve` send to
  `127.0.0.1:<port>`?
  - If it rewrites Host to `127.0.0.1:<port>`, remote requests would pass today's `localOnly()` as
    local. Remote must then be detected from `X-Forwarded-For` / `Tailscale-User-Login`, not from Host.
  - Write the finding into this file.
- Check that a passkey on `*.ts.net` registers and verifies on the user's phone (iOS Safari and/or
  Android Chrome).
- Check "Add to Home Screen" and Web Push on the phone (iOS needs 16.4+ and an installed PWA).

### M1 — Remote access and device pairing

1. **Settings**
   - Add `remoteHosts: string[]` to `HarnessConfig`. It is in `EDITABLE_SETTINGS`
     (`packages/core/src/config.ts`), but only local requests can change it.
   - Empty means no remote access, which is today's behaviour.
2. **Storage**
   - New `devices` table through `Store.migrate()` (`packages/core/src/store.ts:347`), with columns
     `id, name, token_hash, created_at, last_seen_at`.
   - The token is 32 random bytes; only its SHA-256 is stored.
3. **Pairing**
   - `POST /api/pairing` (local only) creates a one-time code: 128-bit, expires in 5 minutes, used once.
   - The settings dialog shows a QR code (`qrcode` package) for `https://<remoteHost>/#pair=<code>`.
   - On the phone, `POST /api/pair {code, name}` returns
     `Set-Cookie: hb_device=<token>; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`.
   - Failed pairing attempts are rate-limited.
4. **Access middleware**
   - `localOnly()` (`packages/server/src/api.ts:29`) becomes `access(...)` in a new
     `packages/server/src/access.ts`.
   - Local: as today.
   - Allowed remote host:
     - `/api/*` needs a valid device cookie (except `/api/pair`), else 401;
     - the client header is still required on non-GET requests;
     - `last_seen_at` is updated, throttled.
   - Any other host: 403.
   - Static files are served without auth. The web shows "this device is not paired" on a 401.
5. **Local-only routes** (remote gets 403). Recommended default; confirm before M1:
   - pairing and device management;
   - `PUT /settings`;
   - `POST /agents`;
   - `PUT /tasks/:id/auto-approve`;
   - `PUT /tasks/:id/allowed-tools`.
6. **Devices**: the settings dialog lists paired devices (name, last seen) with a Revoke button
   (`DELETE /api/devices/:id`). Revoking takes effect on the next request.
7. **Settings UI**: a "Phone access" section that:
   - detects Tailscale through `tailscale status --json` → `Self.DNSName`;
   - fills `remoteHosts`;
   - shows the `tailscale serve --bg <port>` command;
   - starts pairing.
8. **Docs**: README and README.zh-TW get a "Phone access" section. The CHANGELOG changes in the same
   commit as the code.

### M2 — Passkey second factor

1. Server uses `@simplewebauthn/server`, web uses `@simplewebauthn/browser`.
   - `rpID` = the remote host.
   - `userVerification: 'required'`.
2. **Pairing registers a passkey** right after the cookie is issued.
   - The credential id, public key and counter are stored on the device row.
   - A device without a passkey is not paired.
3. **Lock state is kept on the server, per device:** `verified_at`, `last_active_at`.
   - **Locked** (new session, or idle > 30 min): only `/api/auth/*` is allowed.
     - `POST /api/auth/challenge` then `POST /api/auth/verify`.
     - The web shows an unlock screen.
   - **Sensitive routes** answer 401 `{reauth: true}` when `verified_at` is older than 5 min. The
     web runs the passkey prompt and retries the request.
     - The list is kept in one constant, `SENSITIVE_ROUTES` in `access.ts`. Today it holds:
       - `POST /tasks`;
       - `POST /tasks/:id/permission`;
       - plan feedback and approve, criteria approve;
       - `POST /tasks/:id/chat`;
       - `POST /tasks/:id/merge`;
       - `POST /tasks/:id/complete`;
       - `DELETE /tasks/:id`;
       - `PUT /tasks/:id/agents`;
       - `POST /tasks/:id/queue`.
   - A counter that goes backwards is rejected. Failed verifications are rate-limited.
4. **First release** (MINOR or PATCH, to be decided at release time).

### M3 — Phone layout and PWA

1. Check every screen at phone width (`styles.css` already has 1000px and 640px breakpoints):
   - **Board:** one column at a time, with tabs: waiting for you / in progress / review / done.
   - **TaskDrawer:** full screen. Large touch targets in PermissionPrompt, PlanReview and
     CriteriaReview.
   - **DiffView:** horizontal scroll, plus a file-list-only view.
   - **NewTaskDialog and FolderField:** full-screen forms. Folder browsing still lists the computer's
     folders through `listFolders`.
2. **PWA:**
   - `web/public/manifest.webmanifest`;
   - 192 and 512 PNG icons, generated the same way as `desktop/build/icons`;
   - `theme-color`, plus the manifest link in `index.html`.

### M4 — Web Push

1. `web-push` on the server. VAPID keys are generated on first use and stored in `HARNESSBOARD_HOME`,
   never in the repo.
2. Routes: `GET /api/push/key`, `POST /api/push/subscribe`, `DELETE /api/push/subscribe`.
   - The subscription is stored on the device row and removed when the device is revoked.
3. **Trigger**
   - Move `NOTIFY_STATUSES` from `web/src/notify.ts` to `shared`.
   - Subscribe to `harness.subscribe` (the bus behind `/events`, `api.ts:198`).
   - Push once when a task _enters_ one of those statuses.
4. **Payload:** task id, title and status only, never the diff or the chat. A tap opens the task on
   the tab from `openTab()`.
5. **Service worker** `web/public/sw.js` handles `push` and `notificationclick`. The notification
   toggle subscribes to push when the board is opened remotely.

## Tests

Every new or regression test must first fail on the old code. Tests use hard-coded expected values
and no logic.

- **Access**
  - loopback: unchanged;
  - remote without a cookie: 401;
  - valid cookie: 200;
  - revoked: 401;
  - unknown host: 403;
  - remote non-GET without the header: 403;
  - local-only routes from remote: 403;
  - forwarded requests are treated as remote (depends on the M0 finding).
- **Pairing**
  - expired code, reused code, wrong code;
  - rate limit.
- **Passkey** (the verifier sits behind an interface, faked in tests)
  - locked → only `/api/auth/*` is allowed;
  - relocks after 30 min idle;
  - a sensitive route gets `{reauth: true}` after 5 min and passes within 5 min;
  - a backwards counter is rejected.
- **Push** (fake sender)
  - one push when a task enters review;
  - none for a repeated event;
  - none after revoke.

## Verification

- `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- **Real phone:**
  - run on port 4399 with a scratchpad `HARNESSBOARD_HOME`, never touching the user's server on
    4317;
  - run `tailscale serve --bg 4399` and connect from the phone over mobile data;
  - pair, unlock, approve, create a task, receive a push;
  - finish with `tailscale serve reset`.
  - Ask the user before each real-phone session.

## Limits (for the README)

- The computer must be on and Harnessboard running; a sleeping computer is unreachable.
- iOS push needs iOS 16.4+ and the board added to the Home Screen.

## Open questions

- Which routes stay local-only (M1 step 5): confirm before M1.
- MINOR (0.1.0) or PATCH for the first phone release, given the pending macOS and Windows acceptance.
