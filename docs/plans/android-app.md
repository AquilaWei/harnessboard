# Android app

Status: F1–F8 built (branch `hb/13-app-harnessbroad`), waiting for the
[real-phone acceptance](#real-phone-acceptance). Nothing of it has run on a phone or emulator yet.
The user decides the release (version and tag) after the checklist. Planned 2026-10-07.

## Goal

An app that connects to Harnessboard: an icon on the phone that opens the board full screen,
without typing an address or opening Chrome first. It adds no new board features; the phone board
from [phone-access.md](phone-access.md) stays the one UI.

## Decisions

- **Android only, as a Trusted Web Activity (TWA).** The app opens the same phone board in
  Chrome's engine. Cookies, the passkey (rpID = the board host) and Web Push work exactly as in
  Chrome, so pairing, the lock and push needed no server change apart from asset links.
  - Rejected: a WebView app (needs Firebase/FCM for push and WebView WebAuthn), a native UI (a
    second board to keep in step), iOS (Apple Developer account; the iPhone keeps the Home Screen
    web app).
- **Application ID `io.github.aquilawei.harnessboard`.** It cannot change once people install it.
- **No android-browser-helper.** Only `androidx.browser`: the launcher binds the browser's Custom
  Tabs service, launches the TWA and finishes. Without a TWA-capable browser it falls back to a
  Custom Tab; without any browser it shows a toast.
- **Push through the app (notification delegation).** Chrome only hands the board's pushes and
  their taps to an app that both has a `TrustedWebActivityService` and takes the board's URLs.
  - `DelegationService` serves only the browser the launcher last opened the board in (its token
    is saved at launch). On Android 13+ it answers Chrome's `checkNotificationPermission` and
    `getNotificationPermissionRequestPendingIntent`, so the app asks for POST_NOTIFICATIONS.
  - A tap with the app closed: the service worker calls `clients.openWindow('/#task=<id>')` and
    Chrome sends that URL to the app. The launcher opens it in the TWA as it is.
  - The board's host is only known at run time, so the launcher takes every https link (no
    `autoVerify`). Links not on the saved board go to the default browser by package name, never
    back to the app. On Android 8–11 the app can show up in "Open with" lists; Android 12+ never
    picks it for other apps' links.
- **Setup:** scan the pairing QR with Google's code scanner (no camera permission) or type the
  address. Only the origin is saved; the pairing code is passed to the board once.
- **Asset links from the board itself.** `/.well-known/assetlinks.json` lists the fingerprints in
  `androidAppFingerprints` (Settings → Phone access → Android app) and is open without a cookie;
  nothing else under `/.well-known/` is. Chrome fetches the file from the board's origin on the
  phone (`components/content_relationship_verification` in Chromium), so a tailnet-only host
  works. Google's online checker cannot reach it; check with `curl` instead.
- **Distribution:** CI builds and signs the APK on `v*` tags with a key kept only in GitHub
  secrets, and adds it with its SHA256 to the draft release. Without the secrets the release job
  stops. The agent never creates, writes or prints the key; the user runs `keytool`.
- **Version:** read from `packages/server/package.json`; `versionCode` is derived from it.

## Built

| ID  | What                                                                      |
| --- | ------------------------------------------------------------------------- |
| F1  | Gradle project in `android/`, `pnpm android:check`                        |
| F2  | Parse the pairing QR / address (`BoardLink`), store the origin            |
| F3  | Setup screen: scan or type, English and Traditional Chinese               |
| F4  | Launcher: TWA, Custom Tab fallback, "Change board" shortcut               |
| F5  | Server: `/.well-known/assetlinks.json`, `androidAppFingerprints` setting  |
| F6  | Web: "Android app" block in Settings → Phone access                       |
| F7  | CI: signed release APK on `v*` tags, in the draft release with its SHA256 |
| F8  | README sections, CHANGELOG, this checklist                                |

## After the release key exists

The user creates the key and the four `HB_ANDROID_*` secrets (README, Development: "Release
signing key"). Its public fingerprint then becomes the default of `androidAppFingerprints` in
`packages/core/src/config.ts` (the `TODO` there), so a released APK opens without a URL bar with
no setting to fill in. Until then, paste the fingerprint into the setting by hand.

## Real-phone acceptance

Run by the user on the Galaxy S23 Ultra (Chrome) before the release that ships the app. Tick each
step; a step that fails stops the release and goes into this file with what the phone showed. The
phone is on mobile data, not the home Wi-Fi.

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
4. On `http://127.0.0.1:4399`: **Settings → Phone access**, **Add as remote host**, **Save**.
5. Get an APK and its fingerprint, one of:
   - **Release:** `harnessboard-<version>.apk` from a draft release; the fingerprint is in the
     `android` job's log (the last line of "Name the APK after the version").
   - **Debug:** `pnpm android:check`, then `android/app/build/outputs/apk/debug/app-debug.apk`;
     the fingerprint from
     `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android`.
6. Paste the fingerprint under **Settings → Phone access → Android app → App signing
   fingerprints** and **Save**. Then
   `curl https://<machine>.<tailnet>.ts.net/.well-known/assetlinks.json`. Expected: one
   statement for `io.github.aquilawei.harnessboard` with that fingerprint in upper case.

**Install and pair**

7. Fresh install: if an older build is on the phone, uninstall it first. Copy the APK to the
   phone (or `adb install`) and install it. Expected: the Harnessboard icon (white H on blue).
8. Open the app. Expected: "Connect to your board" with **Scan pairing QR** and the address field.
   Type `http://<machine>.<tailnet>.ts.net` and tap **Connect**. Expected: an error saying an
   https:// address is needed; nothing is saved.
9. On the computer: **Pair a phone**. In the app, tap **Scan pairing QR** and scan it. Expected:
   Google's scanner opens without asking for the camera permission, then the board opens with the
   pairing screen.
10. Name the phone, tap **Pair**, then **Create passkey**, and confirm with fingerprint or
    screen lock. Expected: the board appears inside the app; the computer's device list shows
    the name.
11. **No URL bar:** the board fills the screen with no address bar or Chrome toolbar at the top.
    If a bar shows the host name, asset links were not verified: note it and check step 6.
12. Close the app (swipe it away) and open it from the icon. Expected: the board opens directly
    (no setup screen) and asks to unlock. In the task switcher it is its own Harnessboard entry,
    separate from Chrome.
13. Turn the phone sideways while the board is still opening from the icon. Expected: it opens
    once, not twice, and nothing is cut off.

**Lock and passkey**

14. Leave the board open for 31 minutes without touching it, then tap anything. Expected: the
    unlock screen; **Unlock** asks for the passkey and the board comes back.
15. Unlock, wait 6 minutes, then create a task (or approve a permission request). Expected: the
    passkey prompt comes up after the tap and the action completes once confirmed.

**Push**

16. In the app, open **Settings** and switch on **Notify me when a task needs me**. Expected:
    Android asks whether **Harnessboard** (not Chrome) may send notifications; allow it. The
    switch stays on with no error.
17. Swipe the app away and lock the screen. On the computer, make a task wait for permission or
    move one to Review. Expected: within a few seconds a notification "#<id> <title>" with the
    white H icon, listed under Harnessboard (long-press it to see the app), not Chrome.
18. Tap it, with the app still closed. Expected: the task opens **in the app** (no URL bar, not
    a Chrome tab), after unlocking, on the tab that needs you. In the task switcher it is the
    Harnessboard entry.

**Change board and revoke**

19. Long-press the icon. Expected: a **Change board** shortcut. Tap it. Expected: the setup
    screen. Press Back, then open the app from the icon. Expected: the setup screen again (the
    board was forgotten).
20. Type `<machine>.<tailnet>.ts.net` and tap **Connect**. Expected: the board opens and asks to
    unlock, without pairing again (Chrome kept the device cookie).
21. On the computer: **Revoke** the phone. Expected: the next tap in the app shows "This device is
    not paired". Open the board in Chrome on the phone too. Expected: also not paired.

**Teardown**

22. Stop the scratch server, then run `tailscale serve reset` and check `tailscale serve status`
    is empty.
23. Remove the scratch data: `rm -rf "$HARNESSBOARD_HOME"`. Delete the test passkey on the phone
    (Google Password Manager → the tailnet host) and uninstall the app if it was a debug build.
