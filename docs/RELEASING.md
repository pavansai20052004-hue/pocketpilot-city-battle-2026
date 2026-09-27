# Release checklist

This checklist governs an Android app release and the matching laptop dashboard/agent source. A green CI run is necessary but does not replace device acceptance or a distribution-signing review.

## Prepare the candidate

1. Confirm the target release scope and update `CHANGELOG.md`.
2. Keep `apps/mobile/app.json` and `apps/mobile/package.json` on the same app version. Increment Android `versionCode` for every distributed Android build.
3. Run `npm ci` and `npm run check` from the repository root.
4. In `services/agent`, install `.[dev]`, then run `python -m pytest -q`, `python -m ruff check src tests`, and `python -m ruff format --check src tests`.
5. Build the Android release variant using the Actions workflow or the local Android build instructions below.
6. Install the exact candidate on a supported Android device. Check pairing, capture/OCR, dictation where available, local Ollama, cloud warnings if OpenRouter is enabled, analysis, proposal review, approval, passing and failing checks, undo, and the desktop-confirmed GitHub flow.
7. Verify privacy disclosures, app identity/version, Android permissions, crash behavior, and artifact integrity. Do not use production credentials in test runs.

## Build an evaluation APK

The `Build PocketPilot Android APK` workflow runs on relevant changes to `main`, matching pull requests, or manual dispatch. It uploads `pocketpilot-android-apk` for seven days. It does not create a GitHub Release or configure Google Play signing.

For a local build, install Node.js 24+, npm 11+, Java 21, and the Android SDK, then run:

```powershell
npm ci
cd apps/mobile
npx expo prebuild --platform android --no-install
cd android
.\gradlew.bat :app:assembleRelease --no-daemon --console=plain
```

The resulting APK is at `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`. Treat it as an evaluation artifact unless a separate signing and distribution process has been configured and verified.

## Publish a release

Only after device acceptance and distribution checks pass:

1. Finalize the changelog and version metadata.
2. Create a release tag in the form `vX.Y.Z` from the accepted commit.
3. Publish a GitHub Release with the matching notes and only attach an APK whose signature, package identity, version, and checksum have been verified.
4. Keep the Play Store signing key outside the repository and CI logs. Do not claim Play Store readiness until signing and store validation succeed.

Do not label a candidate as released based only on a successful build.
