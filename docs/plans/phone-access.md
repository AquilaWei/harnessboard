# Phone access

Status: M0 done. M1 and M2 are built and waiting for the
[real-phone acceptance](#real-phone-acceptance-m1-and-m2); 0.1.0 is released after it passes.
M3 and M4 are not started. Decisions dated 2026-10-04.

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
- **A verified phone is the user.** It has the same rights as the computer; nothing is
  local-only. Settings-level actions are sensitive, so they need a recent passkey check.
- **Local (loopback) use is unchanged.** It never needs pairing or a passkey.
- **The first phone release is 0.1.0.** The user has accepted every 0.0.x build (2026-10-04).
- **No one-click `tailscale serve` from the app.** The app shows the command to copy.

## Threat model

| Who                                                       | Stopped by                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Anyone on the internet                                    | Not reachable: Tailscale only.                                                                        |
| Another device in the tailnet, or a shared node           | Device pairing: a cookie from a QR code shown on the computer.                                        |
| Someone holding the unlocked phone                        | Passkey, on opening the board and again for sensitive actions.                                        |
| The same person changing settings or pairing a new device | Passkey again: settings, agents, tool rules and devices are sensitive routes.                         |
| A malicious website the phone visits                      | `SameSite=Strict` cookie, the `x-harnessboard-client` header on non-GET requests, and the Host check. |

Recommended Tailscale settings, which go in the README:

- 2FA on the login account;
- device approval;
- an ACL that only lets the user's phone reach this machine.

## Milestones

Each milestone is its own set of commits. M1 is not released on its own. Release 0.1.0 after M2,
once M1 and M2 pass a real-phone acceptance. M3 and M4 follow as 0.1.x or 0.2.0, by the usual
version rules.

### M0 — Spike (no code merged)

- **Highest risk, check first.** What Host and forwarding headers does `tailscale serve` send to
  `127.0.0.1:<port>`?
  - If it rewrites Host to `127.0.0.1:<port>`, remote requests would pass today's `localOnly()` as
    local. Remote must then be detected from `X-Forwarded-For` / `Tailscale-User-Login`, not from Host.
  - Write the finding into this file.
  - **Finding (Tailscale 1.102.4, checked in `ipn/ipnlocal/serve.go` and confirmed on a real run
    from an Android phone over mobile data, 2026-10-04):**
    - Host is kept (`r.Out.Host = r.In.Host`), so the board sees `<machine>.<tailnet>.ts.net` and
      today's `localOnly()` answers 403. Remote requests do not pass as local through Tailscale.
    - Added on every proxied request: `X-Forwarded-Host`, `X-Forwarded-Proto: https`,
      `X-Forwarded-For: <client tailnet IP>`. The TCP peer is always `127.0.0.1`.
    - `Tailscale-User-Login` / `-Name` / `-Profile-Pic` are set for user-owned devices, not for
      tagged ones. Incoming copies are deleted first, so they cannot be spoofed through the proxy.
    - Funnel (public internet) traffic gets `Tailscale-Funnel-Request: ?1` and no identity headers.
    - Other proxies may rewrite Host (nginx sends the `proxy_pass` host by default). So M1 treats any
      request that carries `X-Forwarded-For`, `X-Forwarded-Host` or `Forwarded` as remote, whatever
      its Host, and refuses any request with `Tailscale-Funnel-Request`.
    - The first HTTPS request after enabling certificates took over 30 s while the certificate was
      issued; later requests were immediate.
- **Passkey on `*.ts.net`: works.** Android 16, Chrome 156: registration and verification with
  `rpId = <machine>.<tailnet>.ts.net` and `userVerification: 'required'` both passed, with the UV
  flag set. iOS is not checked; the test phone is Android.
- **In-app browsers have no passkey.** A link opened from LINE loads in its WebView, where
  `window.PublicKeyCredential` and `PushManager` are missing and `credentials.create` fails with
  `NotSupportedError`. M2 must detect this and tell the user to open the board in Chrome or Safari.
- **Push:** Chrome on Android exposes `serviceWorker` and `PushManager` without installing the page.
  Actual delivery and "Add to Home Screen" are checked in M3 and M4, where the manifest and service
  worker exist.

### M1 — Remote access and device pairing

1. **Settings**
   - Add `remoteHosts: string[]` to `HarnessConfig` and `EDITABLE_SETTINGS`
     (`packages/core/src/config.ts`).
   - Empty means no remote access, which is today's behaviour.
2. **Storage**
   - New `devices` table through `Store.migrate()` (`packages/core/src/store.ts:347`), with columns
     `id, name, token_hash, created_at, last_seen_at`.
   - The token is 32 random bytes; only its SHA-256 is stored.
3. **Pairing**
   - `POST /api/pairing` creates a one-time code: 128-bit, expires in 5 minutes, used once.
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
   - A request with `X-Forwarded-For`, `X-Forwarded-Host` or `Forwarded` is never local, even when
     its Host is loopback. A request with `Tailscale-Funnel-Request` is always 403.
   - Static files are served without auth. The web shows "this device is not paired" on a 401.
5. **Settings-level routes are sensitive, not local-only.** From a remote device, they need a fresh
   passkey check (M2) instead of a 403. M1 is not released before M2, so these routes are never open
   to a device without a passkey. The routes:
   - pairing, device listing and revoking;
   - `PUT /settings`, including `remoteHosts`;
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
   - Without `window.PublicKeyCredential` (in-app browsers such as LINE's), the web shows "open this
     page in Chrome or Safari" instead of the pairing or unlock button.
2. **Pairing registers a passkey** right after the cookie is issued.
   - The credential id, public key and counter are stored on the device row.
   - A device without a passkey is not paired.
3. **Lock state is kept on the server, per device:** `verified_at`, `last_active_at`.
   - **Locked** (new session, or idle > 30 min): only `/api/auth/*` is allowed.
     - A session starts only with a passed passkey check or registration, which answers a token.
       The web keeps it in page memory and sends it as `X-Harnessboard-Session` (`?session=` on
       `GET /api/events`). Opening the board again, or a server restart, starts a new session.
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
       - `POST /tasks/:id/queue`;
       - the settings-level routes from M1 step 5.
   - A counter that goes backwards is rejected. Failed verifications are rate-limited.
4. **Release 0.1.0** after the real-phone acceptance of M1 and M2.

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
  - loopback Host with `X-Forwarded-For`: treated as remote (401 without a cookie);
  - `Tailscale-Funnel-Request: ?1`: 403.
- **Pairing**
  - expired code, reused code, wrong code;
  - rate limit.
- **Passkey** (the verifier sits behind an interface, faked in tests)
  - locked → only `/api/auth/*` is allowed;
  - relocks after 30 min idle;
  - a sensitive route gets `{reauth: true}` after 5 min and passes within 5 min;
  - a settings route (`PUT /settings`) from remote gets `{reauth: true}` after 5 min;
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

### Real-phone acceptance (M1 and M2)

Run by the user before 0.1.0. Tick each step; a step that fails stops the release and goes into
this file with what the phone showed. The phone is on mobile data, not the home Wi-Fi.

**Setup (on the computer)**

1. Check that no other `tailscale serve` is running: `tailscale serve status`.
2. Build and start a scratch server on port 4399, never the everyday server on 4317:

   ```bash
   pnpm build
   export HARNESSBOARD_HOME=$(mktemp -d /tmp/hb-accept-XXXX)
   node packages/server/dist/cli.js serve --port 4399
   ```

3. In another terminal: `tailscale serve --bg 4399`. Open `https://<machine>.<tailnet>.ts.net`
   once on the computer and wait for the certificate (up to about 30 s).
4. Open `http://127.0.0.1:4399` on the computer. No pairing or passkey is asked for.

**M1: remote access and pairing**

5. Before pairing, open `https://<machine>.<tailnet>.ts.net` on the phone. Expected: 403, because
   the host is not saved yet.
6. On the computer: **Settings → Phone access** shows the Tailscale name. **Add as remote host**,
   **Save**. The section shows `tailscale serve --bg 4399`.
7. Reload the page on the phone. Expected: "This device is not paired".
8. On the computer: **Pair a phone**. Scan the QR code with the phone's camera and open it in Chrome.
9. Enter a device name and tap **Pair**, then **Create passkey**, and confirm with fingerprint or
   screen lock. Expected: the board appears; the computer's device list shows the name with a
   recent "Last seen".
10. Scan the same QR code again from another browser profile or after clearing site data.
    Expected: the code is refused (used once).
11. On the computer: **New code**, and send the address under the QR code to yourself in LINE.
    Open it inside LINE. Expected: the "cannot use passkeys" message instead of a Pair button.
    Use LINE's **Open in browser**. Expected: Chrome shows the pairing screen, because the code
    stayed in the address. Pairing there is optional; revoke that device afterwards.

**M2: lock, unlock and sensitive actions**

12. Reload the board on the phone. Expected: "The board is locked"; **Unlock** asks for the
    passkey and the board comes back.
13. Leave the board open for 31 minutes without touching it, then tap anything. Expected: the
    unlock screen.
14. Unlock, wait 6 minutes, then create a task (or approve a permission request, or **Start** a
    draft). Expected: the passkey prompt comes up after the tap, without a second tap, and the
    action completes once confirmed. On Safari especially, note whether the browser refused the
    prompt because it did not follow the tap directly.
15. Cancel that prompt instead. Expected: the toast "Not done: a phone must confirm this with its
    passkey", and the action did not happen.
16. With the board open and unlocked on the phone, stop the server (Ctrl+C) and start it again
    with the same command. Expected: the phone shows the unlock screen; after unlocking, card
    changes made on the computer appear on the phone without a reload.
17. Within 5 minutes of a passkey check, open **Settings** on the phone and change a setting.
    Expected: it saves without a prompt. After 6 minutes, it asks first.
18. On the computer: **Revoke** the phone. Expected: the next tap on the phone shows "This device
    is not paired".

**Teardown**

19. Stop the scratch server, then run `tailscale serve reset` and check `tailscale serve status`
    is empty.
20. Remove the scratch data: `rm -rf "$HARNESSBOARD_HOME"`. Delete the test passkey on the phone
    (Google Password Manager → passkeys) so it does not pile up.

## Limits (for the README)

- The computer must be on and Harnessboard running; a sleeping computer is unreachable.
- iOS push needs iOS 16.4+ and the board added to the Home Screen.
