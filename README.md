# PocketPilot AI — City Battle build

PocketPilot is a phone-first developer assistant. A phone captures an error, a local laptop agent inspects a bounded repository window, and a local model explains the cause. A proposed change is shown as a diff and requires explicit human approval before the agent can apply it and run an allowlisted test. Undo is guarded against overwriting later edits.

This is a **new implementation written during the Hyderabad City Battle event window**. The earlier PocketPilot prototype was used as product and architecture reference, not copied into this repository.

## Components

- `apps/mobile` — Android-first Expo application and the primary user interface
- `apps/desktop-web` — laptop pairing, workspace setup, and session dashboard
- `services/agent` — local FastAPI authority for workspace, local Ollama, proposals, tests, and undo
- `packages/shared-types` — frontend API contract
- The Android app can capture errors with the camera or screenshot, or dictate notes using an installed offline speech model. Dictation is editable and is never submitted automatically.

The normal development path is `npm install`, then `npm run dev:desktop` and `npm run dev:mobile` in separate terminals. The agent has its own Python environment and startup command in `services/agent/README.md`.

Office Kit is used by the participant to control the laptop from the loaner iQOO during Red Light. PocketPilot does **not** claim an undocumented Office Kit developer API integration; the app-to-agent connection uses an authenticated local-network API.

## Safety boundary

The phone never receives arbitrary shell access. The laptop agent is the only process allowed to read or modify the selected workspace. Source context is bounded; generated, secret-like, and dependency paths are excluded. Model output is advisory and untrusted. A proposal needs the exact matching approval ID and revision before a file changes.

Voice notes use Android on-device recognition only. If the English offline speech model is missing, Android may ask to download it once; PocketPilot does not fall back to network transcription. Only the transcript is sent to the laptop after the participant reviews it and taps Analyze.

## Status

The core loop was verified on the loaner iQOO on 26 September 2026 with Android build 1.0.4. The phone paired to the laptop agent, the submitted error resolved to `pricing.py:2` with high confidence, and the model proposed a one-file change. After phone approval, the agent ran `python -m pytest -q` and reported **2 passed**. Undo then restored the original `pricing.py`; the agent's final session stage was `undone`. The participant also confirmed that microphone input was available in the corrected Android build.

This proves the bounded Python demo path, not arbitrary-project repair. The participant additionally verified a gallery scan of the terminal error through high-confidence analysis, fix, verification, and undo. A live camera photo still needs a separate physical-phone check.

After this phone run, the agent gained a local recovery record for its current session and approved edit, plus nearest-project test selection for Python, Maven, and narrowly allowlisted npm scripts. These additions passed automated tests, including a real Node test run, but have **not yet been retested on the loaner phone**. See the [agent documentation](services/agent/README.md) for boundaries.
