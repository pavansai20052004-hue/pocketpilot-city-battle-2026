# PocketPilot — Round 1 evaluation runbook

## Demo position (about two minutes)

1. **The problem (15 seconds).** A developer sees a failure on the laptop but may be working from the phone. Copying logs into a general chatbot does not give a bounded, reviewable change to the actual project.
2. **The phone-first flow (25 seconds).** Show the failing terminal output: `pricing.py:2`, `1 failed, 1 passed`. On the iQOO, show the captured or pasted error and the grounded, high-confidence explanation. The laptop runs the local Ollama model; the phone controls the workflow.
3. **Human control (35 seconds).** Open the proposed one-file diff. Say: "No file changed during analysis or generation. I must approve this exact proposal." Tap **APPROVE & VERIFY**. Show the two passing tests and the source change in the desktop project.
4. **Safe recovery (20 seconds).** Tap **UNDO FIX**. Show the original source restored. Explain that undo checks the current file hash, so it will not overwrite a later manual edit.
5. **Differentiation (20 seconds).** PocketPilot combines on-phone capture and optional offline dictation, local model reasoning on the paired laptop, repository-grounded location, explicit diff approval, fixed project test commands, and hash-guarded undo. It does not give the model arbitrary shell access.

## Prepare before judges arrive

- Keep the installed Android 1.0.4 APK. Do not install an unverified build during Round 1.
- Confirm the phone says **LINKED**, the desktop shows the selected `demo/discount-case` workspace, and the local model is ready.
- The demo starts from the broken `pricing.py`. Running tests should show `1 failed, 1 passed` and `pricing.py:2`.
- If time permits, perform analysis and **GENERATE FIX** before the live pitch. Stop on the diff approval screen. This avoids making judges wait for model generation.
- Do not tap approval until you are ready to demonstrate the file change and test result. Do not manually edit `pricing.py` after generating the proposal; its hash guard will reject a stale diff.
- After the demo, tap **UNDO FIX** to restore the fixture for another run.

## Honest answers to likely questions

- **Why not ChatGPT?** ChatGPT is useful for advice. PocketPilot's differentiator is the controlled phone-to-project workflow: grounded source evidence, an exact reviewed diff, human approval, a real project test, and safe undo. The local model is an implementation choice, not a claim that it is smarter than ChatGPT.
- **Does it use Office Kit?** The participant uses Office Kit to operate the laptop from the loaner iQOO during Red Light. PocketPilot itself uses an authenticated local-network connection to the laptop agent; it does not claim an undocumented Office Kit developer API.
- **Is it fully offline?** The model runs locally on the laptop. Error images are processed on the phone. Dictation requires an installed Android offline speech model. The phone and laptop still need a working local connection. Do not say every feature works with no connectivity.
- **Can it fix any project?** No. This demo proves the bounded Python flow. Source location must be grounded in an indexed file, proposals are limited to one file, and only supported project test commands can mark a result verified. The agent now detects nested Python, Maven, and selected npm test projects, but those non-Python flows have not yet been phone-verified in this event build.
- **Was this code built during the event?** This City Battle repository was created during the event. The pre-event prototype informed the design and architecture, as the organizer allowed; source was not copied into this event repository.

## If something stalls

- If generation takes time, explain that the local model is working and show the live progress screen. Do not claim an ETA.
- If the phone is disconnected, check the laptop's current Wi-Fi address; it can change at the venue. Generate a new pairing code on the desktop dashboard and re-pair.
- If OCR misses the file/line, review and correct the extracted text before analysis. For the most reliable live path, paste the known stack trace including `pricing.py:2`.
- If the model or tests fail during the live pitch, show the existing verified session evidence and describe the failure honestly. Do not say "verified" without a passing test result.
