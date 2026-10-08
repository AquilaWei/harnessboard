# Development

```bash
corepack enable        # provides the pinned pnpm version
pnpm install
pnpm test              # uses a fake claude CLI; no account needed
# optional: also run the Gemini read-only policy tests against Gemini's own policy engine
npm install --no-save --prefix /tmp/gemini-core @google/gemini-cli-core@0.62.0
HARNESSBOARD_TEST_GEMINI_CORE=/tmp/gemini-core/node_modules/@google/gemini-cli-core pnpm test
pnpm lint && pnpm typecheck
pnpm --filter @harnessboard/web dev   # UI with hot reload; proxies /api to a running `hb serve`
```

**Android app** (in `android/`, still in progress): it needs a JDK and the Android SDK with
platform 37, found through `ANDROID_HOME` or the default install folder. See
[Android app in CONTRIBUTING.md](../CONTRIBUTING.md#android-app) for the setup.

```bash
pnpm android:check                              # ktlint, unit tests, Android lint, debug APK
HARNESSBOARD_SKIP_ANDROID=1 pnpm android:check  # skip it on a machine without the SDK
```

**Release signing key for the APK.** On a `v*` tag, CI builds `harnessboard-<version>.apk`,
signs it and adds it, with its SHA256, to the draft release. The key lives only in the repo's
GitHub secrets; **without them the release job stops** (an unsigned APK will not install).
Create the key once, **outside the repo**, and keep a backup: Android only installs an update
signed with the same key.

```bash
keytool -genkeypair -v -keystore ~/harnessboard-release.jks -storetype PKCS12 \
  -alias harnessboard -keyalg RSA -keysize 4096 -validity 10000
base64 < ~/harnessboard-release.jks | gh secret set HB_ANDROID_KEYSTORE
gh secret set HB_ANDROID_KEYSTORE_PASSWORD   # prompts; the password you gave keytool
gh secret set HB_ANDROID_KEY_ALIAS --body harnessboard
gh secret set HB_ANDROID_KEY_PASSWORD        # prompts; the same password (PKCS12 has one)
keytool -list -v -keystore ~/harnessboard-release.jks -alias harnessboard | grep SHA256:
```

The last line prints the key's **public** SHA-256 fingerprint (CI prints it too); it becomes
the default of the `androidAppFingerprints` setting so the app opens without a URL bar.
To build a release APK yourself, set the same four variables before
`cd android && ./gradlew assembleRelease`; without them it builds `app-release-unsigned.apk`.
The debug APK from `pnpm android:check` (`android/app/build/outputs/apk/debug/app-debug.apk`)
is signed with this computer's debug key; print its fingerprint with:

```bash
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android | grep SHA256:
```
