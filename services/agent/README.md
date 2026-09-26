# PocketPilot local agent

Fresh City Battle FastAPI agent. It owns one explicitly selected project folder, local AI calls, reviewable proposals, approved file changes, fixed test commands, and hash-guarded undo. The phone is the primary control surface; the laptop dashboard selects the workspace and creates a temporary pairing code.

## Start on the laptop

From `services/agent` in a PowerShell terminal:

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -e '.[dev]'
.\.venv\Scripts\python -m uvicorn pocketpilot_agent.main:app --host 0.0.0.0 --port 8000
```

The dashboard should call `http://127.0.0.1:8000`. The phone uses the laptop's current LAN address and port `8000`; both devices must be on a trusted private network that allows a direct connection. LAN traffic uses HTTP, not TLS, so do not use this pairing flow on public or untrusted Wi-Fi. Only the dashboard's loopback requests can choose a workspace or issue a pairing code. Phone requests use the one-time code to obtain a Bearer token. Tokens are held in memory, expire after 36 hours, and are revoked when the phone is unpaired; agent restart revokes all tokens.

Run checks with:

```powershell
.\.venv\Scripts\python -m pytest -q
.\.venv\Scripts\python -m ruff check src tests
.\.venv\Scripts\python -m ruff format --check src tests
```

## API workflow

1. Dashboard `POST /api/workspace` with `{ "path": "..." }` and `POST /api/pairing-code`.
2. Phone `POST /api/pair` with `{ "code": "...", "device_name": "..." }`, then sends `Authorization: Bearer <token>`.
3. Phone `POST /api/sessions` with `{ "error_text": "...", "source": "text" }`. This returns `202` immediately; poll `GET /api/state` until `root_cause_found` or `analysis_failed`.
4. Phone `POST /api/sessions/{id}/proposal`. This returns `202`; poll state until `awaiting_approval` or `failed`. Nothing is changed yet.
5. Phone `POST /api/sessions/{id}/approve` with the exact `proposal_id` and current `revision`. The agent verifies the source hash, applies the reviewed edit, and runs an allowlisted test command. It returns `verified` only when the command succeeds.
6. Phone may `POST /api/sessions/{id}/undo` with the current `revision`; the agent restores only when the file still matches the applied patch hash.
7. After a passing check, the phone may request a GitHub publish. The laptop dashboard then shows the exact repository, branch, file, and commit message and requires a loopback-only desktop confirmation before Git runs. The laptop creates a commit for only the verified source file, then performs a normal (never force) push of that exact commit. Retries reuse the same commit and first check the remote branch. If a commit attempt has an uncertain outcome, undo stays blocked until the local Git state is reviewed.

`GET /api/dashboard` is loopback-only, while `GET /api/health` is safe to query for connectivity. Errors use FastAPI's `{ "detail": "..." }` response. `GET /api/state` and `GET /api/dashboard` share the same snapshot shape.

## Boundaries and limitations

- AI is local Ollama (`qwen3-coder:30b` by default); generated analysis and edits are untrusted.
- Only one active session and one selected source file are supported in this MVP. Ambiguous locations may be analyzed but cannot be patched.
- The selected project must contain supported Python, Java, C#, JavaScript, or TypeScript source files. Symlinks, hidden/dependency/build trees, credential-like filenames, and oversized source files are excluded. The locator understands common `file.ext:line`, compiler `file.ext(line,column)`, Python traceback, JavaScript/Java stack, and .NET `in file.cs:line N` locations. A file must resolve uniquely inside the selected project, and test files are never patch targets.
- The model only suggests an exact replacement in the matched file. The agent validates it before showing a diff. No model text becomes a shell command.
- GitHub publishing uses Git and the laptop's existing credential manager; no GitHub token is stored in the phone app or sent over the pairing connection. The workspace must be the Git repository root, have a clean working tree before a fix is approved, and have one unambiguous GitHub fetch/push destination. The current local branch and remote branch must still match the captured baseline. Only the verified source file is staged; unrelated or generated changes stop publishing. GitHub credentials should already be configured on the laptop. The phone submits a request, but the laptop dashboard performs the final confirmation and discloses that configured local Git hooks may run.
- A published fix cannot be undone from PocketPilot because it is part of Git history. The session is retained in local history; after a successful push, starting another session archives it without reverting the committed source.
- Automatic verification selects the nearest project manifest above the changed source file. It recognizes Maven (`mvn -q test`), Gradle (`gradle test` or the project's `gradlew` wrapper), .NET solutions/projects (`dotnet test`), Python projects with `pyproject.toml`/`pytest.ini` (`python -m pytest -q`), and narrowly allowlisted npm test scripts (`vitest`, `vitest run`, `jest`, `jest --runInBand`, `react-scripts test`, or `node --test`). Unsupported or ambiguous project setups remain unverified. Project tests execute project code, so select only folders you trust.
- The current session and pre-edit snapshot are atomically saved outside the project in the user's local app-data directory. If the agent restarts after a fix, re-pair the phone; the verified or failed session can still be undone if the file has not changed again. In-flight analysis/generation/verification is interrupted, never silently resumed. The recovery record contains captured error text and source snapshots; keep this local file private.
- Up to 25 completed session summaries are stored separately under the local app-data directory and shown on the phone and dashboard. History excludes raw error text, source, diffs, and test output. The debugger still allows one active session at a time; an applied patch must be undone before starting another.
- Office Kit is used by the participant to operate the laptop remotely. This agent does not claim a vendor Office Kit API integration.
