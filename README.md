# PocketPilot AI — City Battle build

PocketPilot is a phone-first developer assistant. A phone captures an error, a local laptop agent inspects a bounded repository window, and a local model explains the cause. A proposed change is shown as a diff and requires explicit human approval before the agent can apply it and run an allowlisted test. Undo is guarded against overwriting later edits.

This is a **new implementation written during the Hyderabad City Battle event window**. The earlier PocketPilot prototype was used as product and architecture reference, not copied into this repository.

## Components

- `apps/mobile` — Android-first Expo application and the primary user interface
- `apps/desktop-web` — laptop pairing, workspace setup, and session dashboard
- `services/agent` — local FastAPI authority for workspace, local Ollama, proposals, tests, and undo
- `packages/shared-types` — frontend API contract

The normal development path is `npm install`, then `npm run dev:desktop` and `npm run dev:mobile` in separate terminals. The agent has its own Python environment and startup command in `services/agent/README.md`.

Office Kit is used by the participant to control the laptop from the loaner iQOO during Red Light. PocketPilot does **not** claim an undocumented Office Kit developer API integration; the app-to-agent connection uses an authenticated local-network API.

## Safety boundary

The phone never receives arbitrary shell access. The laptop agent is the only process allowed to read or modify the selected workspace. Source context is bounded; generated, secret-like, and dependency paths are excluded. Model output is advisory and untrusted. A proposal needs the exact matching approval ID and revision before a file changes.

## Status

This repository is being built incrementally during the event. A green build and a physical-phone end-to-end check are required before a feature is described as verified.
