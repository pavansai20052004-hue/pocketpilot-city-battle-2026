# PocketPilot local agent

Fresh City Battle FastAPI agent. It owns one explicitly selected project folder, local AI calls, reviewable proposals, approved file changes, fixed test commands, and hash-guarded undo. The phone is the primary control surface; the laptop dashboard selects the workspace and creates a temporary pairing code.

## Start on the laptop

From `services/agent` in a PowerShell terminal:

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -e '.[dev]'
.\.venv\Scripts\python -m uvicorn pocketpilot_agent.main:app --host 0.0.0.0 --port 8000
```

The dashboard should call `http://127.0.0.1:8000`. The phone uses the laptop's current LAN address and port `8000`; both devices must be on a network that allows a direct connection. Only the dashboard's loopback requests can choose a workspace or issue a pairing code. Phone requests use the one-time code to obtain a Bearer token. Tokens are in memory and expire when the agent restarts.

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

`GET /api/dashboard` is loopback-only, while `GET /api/health` is safe to query for connectivity. Errors use FastAPI's `{ "detail": "..." }` response. `GET /api/state` and `GET /api/dashboard` share the same snapshot shape.

## Boundaries and limitations

- AI is local Ollama (`qwen3-coder:30b` by default); generated analysis and edits are untrusted.
- Only one active session and one selected source file are supported in this MVP. Ambiguous locations may be analyzed but cannot be patched.
- The selected project must contain supported source files. Symlinks, hidden/dependency/build trees, credential-like filenames, and oversized source files are excluded.
- The model only suggests an exact replacement in the matched file. The agent validates it before showing a diff. No model text becomes a shell command.
- Automatic verification currently recognizes Maven (`mvn -q test`) or Python projects with `pyproject.toml`/`pytest.ini` (`python -m pytest -q`). Other project types require adding a reviewed fixed command before they can be called verified. Project tests themselves are code and should be trusted only for projects the user intentionally selected.
- State is currently in-memory, so restart requires re-pairing and loses session history. Existing source changes are not reverted on restart; inspect the project before continuing.
- Office Kit is used by the participant to operate the laptop remotely. This agent does not claim a vendor Office Kit API integration.
