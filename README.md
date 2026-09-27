# PocketPilot AI — City Battle build

PocketPilot is a phone-first developer assistant. A phone captures an error, a laptop agent inspects a bounded repository window, and the selected model explains the cause. A proposed change is shown as a diff and requires explicit human approval before the agent can apply it and run an allowlisted test. Undo is guarded against overwriting later edits.

This is a **new implementation written during the Hyderabad City Battle event window**. The earlier PocketPilot prototype was used as product and architecture reference, not copied into this repository.

## Components

- `apps/mobile` — Android-first Expo application and the primary user interface
- `apps/desktop-web` — laptop pairing, workspace setup, and session dashboard
- `services/agent` — laptop FastAPI authority for workspace, configured Ollama/OpenRouter inference, proposals, tests, and undo
- `packages/shared-types` — frontend API contract
- The Android app can capture errors with the camera or screenshot, or dictate notes/questions using an installed offline speech model. Error notes remain editable before analysis; a Pilot voice question is sent after transcription finishes.
- Pilot is a voice-and-text debugging companion grounded in the active session. It can explain evidence, proposed changes, validation status, and next steps, but cannot run tools, approve edits, or publish code. Its short conversation memory is bounded, held only in laptop RAM, and can be cleared.
- The desktop dashboard can switch all AI calls (analysis, fix proposals, and Pilot) to OpenRouter. The key is submitted only to the loopback laptop agent and held in its memory until restart; it is not saved to the browser, APK, or repository. Ollama remains active until the dashboard verifies an OpenRouter key and model.
- The phone and dashboard show up to 25 recent session outcomes. The laptop stores only a small local summary; raw error logs, source code, proposed diffs, and test output are not added to history.

The normal development path is `npm install`, then `npm run dev:desktop` and `npm run dev:mobile` in separate terminals. The agent has its own Python environment and startup command in `services/agent/README.md`.

For a local laptop + iQOO run, `npm run start:local` checks the existing services, builds the desktop dashboard if needed, and starts any missing dashboard/agent processes. It reports local Ollama readiness. If it starts services, it keeps the terminal open; press Ctrl+C to stop only the services started by that command. If both services are already running, it reports their status and exits. The dashboard remains on `127.0.0.1:4173`, and the phone agent remains LAN-accessible on port `8000`. Use a trusted private Wi-Fi network only. This is a local run helper, not a standalone installer or public hosting setup. `npm run start:local -- --check` reports current dashboard, agent, and Ollama readiness without starting processes.

Office Kit is used by the participant to control the laptop from the loaner iQOO during Red Light. PocketPilot does **not** claim an undocumented Office Kit developer API integration; the app-to-agent connection uses an authenticated local-network API.

## Safety boundary

The phone never receives arbitrary shell access. The laptop agent is the only process allowed to read or modify the selected workspace. Source context is bounded; generated, secret-like, and dependency paths are excluded. Model output is advisory and untrusted. A proposal needs the exact matching approval ID and revision before a file changes.

Voice recognition uses Android on-device recognition only. If the English offline speech model is missing, Android may ask to download it once; PocketPilot does not fall back to network transcription. With Ollama active, AI prompts stay on the laptop. With OpenRouter active, error text, a bounded matched source window, fix instructions, and Pilot context are sent from the laptop to OpenRouter for every model call. Common credential patterns are redacted, but redaction is best-effort: review inputs and never submit credentials or code you are not authorized to share. The API key stays on the laptop backend in memory only. The phone-to-laptop bridge uses HTTP, so pair only on trusted Wi-Fi.

## Status

The core loop was verified on the loaner iQOO on 26 September 2026: the phone paired to the laptop agent, the submitted error resolved to `pricing.py:2` with high confidence, approval applied a one-file patch, `python -m pytest -q` reported **2 passed**, and Undo restored the original file. The participant also confirmed working microphone input. The participant later reported successful verify-and-undo checks for Java, JavaScript, TypeScript, and C# demo cases; those language checks are participant-reported, not rerun as part of this build.

Build **1.0.9 (Android versionCode 10)** adds a Pilot text/voice conversation panel, session-aware suggested questions, spoken replies, short-lived per-device chat memory, explicit clear/discard behavior, and an updated blue/amber desktop/mobile theme. The participant confirmed Pilot chat works on the iQOO. The OpenRouter runtime configuration and cloud-egress warnings are being added to the source; the current 1.0.9 APK does not include those changes. A broader voice-conversation and release-acceptance pass remains. The APK is signed with the local Gradle debug key for testing; it is not a Play Store signing key.

This remains a bounded developer-assistant workflow, not guaranteed repair for arbitrary projects. The agent indexes Java, C#, JavaScript, and TypeScript alongside Python, recognizes common compiler/stack-trace locations, and selects bounded Maven/Gradle, .NET, and allowlisted npm verification commands. See the [agent documentation](services/agent/README.md) for boundaries and validation requirements.

The standalone local APK, `PocketPilot-CityBattle-1.0.9.apk`, is copied to the user's Desktop for install testing. It is debug-signed, so Android may not allow it to update an EAS-signed installation without first removing the older app. Restarting the laptop agent revokes existing phone pairings; use **NEW CODE** on the desktop dashboard to pair again.
