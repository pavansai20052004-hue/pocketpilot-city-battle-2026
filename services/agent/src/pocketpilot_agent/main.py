"""Authenticated phone workflow and loopback-only desktop controls."""

import asyncio
import difflib
import os
import secrets
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .github_publish import GitBaseline, GitHubPublisher, GitPublishError, commit_message
from .history import SessionHistoryStore
from .models import (
    Analysis,
    ApprovalRequest,
    GitHubPublishRequest,
    GitHubPublishState,
    NewSessionRequest,
    PairRequest,
    Proposal,
    ProposedFile,
    PublishConfirmationRequest,
    Session,
    UndoRequest,
    WorkspaceRequest,
)
from .provider import MODEL, OllamaProvider, ProviderError
from .recovery import RecoveryStore
from .workspace import SourceMatch, Workspace, digest

DEVICE_TOKEN_TTL_SECONDS = 36 * 60 * 60


def text_field(value: object, fallback: str, limit: int = 1500) -> str:
    return str(value).strip()[:limit] if isinstance(value, str) and value.strip() else fallback


class AgentState:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.recovery = RecoveryStore()
        self.history = SessionHistoryStore()
        self.recovery_error: str | None = None
        self.workspace: Workspace | None = None
        self.session: Session | None = None
        self.match: SourceMatch | None = None
        self.proposed_bytes: bytes | None = None
        self.original_bytes: bytes | None = None
        self.patched_sha: str | None = None
        self.git_baseline: GitBaseline | None = None
        self.pairing_code: str | None = None
        self.pairing_expiry: float = 0
        self.tokens: dict[str, tuple[str, float]] = {}
        self.pair_attempts: dict[str, list[float]] = {}
        self.provider = OllamaProvider()
        try:
            (
                self.workspace,
                self.session,
                self.match,
                self.proposed_bytes,
                self.original_bytes,
                self.patched_sha,
                self.git_baseline,
            ) = self.recovery.load()
            self.reconcile_recovery()
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            self.recovery_error = f"Saved recovery state could not be loaded: {exc}"
            self.workspace = None
            self.reset_session()

    def persist(self) -> None:
        self.recovery.save(
            self.workspace,
            self.session,
            self.match,
            self.proposed_bytes,
            self.original_bytes,
            self.patched_sha,
            self.git_baseline,
        )
        if self.session:
            self.history.record(self.session)

    def reconcile_recovery(self) -> None:
        if self.session is None:
            return
        undo_safe = False
        if self.patched_sha and self.workspace and self.match:
            current_sha = digest(self.workspace.safe_file(self.match.path).read_bytes())
            if current_sha == self.match.sha256:
                # The journal was saved, but the process stopped before the edit.
                self.patched_sha = None
                self.original_bytes = None
                self.git_baseline = None
                if self.session.github_publish:
                    self.session.github_publish.status = "unavailable"
                    self.session.github_publish.detail = (
                        "The fix was not applied, so there is nothing to publish."
                    )
                if self.session.stage in {"verified", "failed"}:
                    self.session.stage = "undone"
                    self.session.error_message = None
                    self.session.revision += 1
                    self.persist()
            elif current_sha != self.patched_sha:
                self.session.error_message = (
                    "Source changed after the applied fix. Automatic undo is blocked."
                )
            else:
                undo_safe = True
        if self.session.stage in {"analyzing", "generating_fix", "testing"}:
            self.session.stage = "failed" if self.patched_sha else "analysis_failed"
            self.session.error_message = "The laptop agent restarted during this step." + (
                " The applied fix can still be undone."
                if undo_safe
                else (
                    " Source changed; automatic undo is blocked."
                    if self.patched_sha
                    else " Start a new analysis."
                )
            )
            self.session.revision += 1
            self.persist()
        if self.session.github_publish and self.session.github_publish.status == "committing":
            self.session.github_publish.status = "commit_failed"
            self.session.github_publish.detail = "The laptop restarted during the commit. Retry to safely resume or inspect Git first."
            self.persist()
        elif self.session.github_publish and self.session.github_publish.status == "pushing":
            self.session.github_publish.status = "upload_failed"
            self.session.github_publish.detail = "The laptop restarted during upload. Retry checks GitHub first and reuses the same commit."
            self.persist()

    def reset_session(self) -> None:
        self.session = None
        self.match = None
        self.proposed_bytes = None
        self.original_bytes = None
        self.patched_sha = None
        self.git_baseline = None


app = FastAPI(title="PocketPilot City Battle Agent", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:4173",
        "http://localhost:4173",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)
state = AgentState()
github_publisher = GitHubPublisher()


def loopback_only(request: Request) -> None:
    peer = request.client.host if request.client else ""
    if peer not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(403, "Desktop controls are available only on this laptop")


def prune_expired_tokens() -> None:
    now = time.time()
    for token, (_device_name, expires_at) in list(state.tokens.items()):
        if expires_at <= now:
            state.tokens.pop(token, None)


def paired_only(authorization: str | None = Header(default=None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Pair the phone before using this endpoint")
    token = authorization[7:]
    prune_expired_tokens()
    for known in state.tokens:
        if secrets.compare_digest(token, known):
            return known
    raise HTTPException(401, "Invalid or expired device token")


def active_session(session_id: str) -> Session:
    current = state.session
    if current is None or current.id != session_id:
        raise HTTPException(404, "Session not found")
    return current


async def snapshot() -> dict:
    prune_expired_tokens()
    workspace = state.workspace
    return {
        "workspace": {
            "path": str(workspace.root) if workspace else None,
            "ready": workspace is not None,
            "files": len(workspace.files) if workspace else 0,
        },
        "provider": {"ready": await state.provider.ready(), "model": MODEL},
        "pairing": {"connected_devices": len(state.tokens)},
        "session": state.session.model_dump() if state.session else None,
        "history": [item.model_dump() for item in state.history.items],
        "history_error": state.history.last_error,
        "recovery_error": state.recovery_error,
    }


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "model": MODEL, "ollama_ready": await state.provider.ready()}


@app.get("/api/dashboard", dependencies=[Depends(loopback_only)])
async def dashboard() -> dict:
    return await snapshot()


@app.post("/api/workspace", dependencies=[Depends(loopback_only)])
async def select_workspace(body: WorkspaceRequest) -> dict:
    if state.recovery_error:
        raise HTTPException(409, state.recovery_error)
    try:
        workspace = Workspace(body.path)
    except (OSError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc
    async with state.lock:
        if (
            state.session
            and state.session.stage in {"testing", "verified", "failed"}
            and state.patched_sha
        ):
            raise HTTPException(409, "Undo or finish the current patch before changing workspace")
        state.workspace = workspace
        state.reset_session()
        state.persist()
    return await snapshot()


@app.post("/api/pairing-code", dependencies=[Depends(loopback_only)])
async def pairing_code() -> dict:
    async with state.lock:
        state.pairing_code = f"{secrets.randbelow(100_000_000):08d}"
        state.pairing_expiry = time.monotonic() + 300
        return {"code": state.pairing_code, "expires_at": int(time.time() + 300)}


@app.post("/api/pair")
async def pair(request: Request, body: PairRequest) -> dict:
    peer = request.client.host if request.client else "unknown"
    now = time.monotonic()
    async with state.lock:
        attempts = [when for when in state.pair_attempts.get(peer, []) if now - when < 60]
        if len(attempts) >= 8:
            raise HTTPException(429, "Too many pairing attempts; wait a minute")
        attempts.append(now)
        state.pair_attempts[peer] = attempts
        if (
            state.pairing_code is None
            or now > state.pairing_expiry
            or not secrets.compare_digest(body.code, state.pairing_code)
        ):
            raise HTTPException(401, "Pairing code is invalid or expired")
        token = secrets.token_urlsafe(32)
        state.tokens[token] = (body.device_name, time.time() + DEVICE_TOKEN_TTL_SECONDS)
        state.pairing_code = None
    return {
        "token": token,
        "device_name": body.device_name,
        "expires_at": int(time.time() + DEVICE_TOKEN_TTL_SECONDS),
    }


@app.post("/api/unpair")
async def unpair(_token: str = Depends(paired_only)) -> dict:
    state.tokens.pop(_token, None)
    return {"revoked": True}


@app.get("/api/state")
async def phone_state(_device: str = Depends(paired_only)) -> dict:
    return await snapshot()


async def analyze_in_background(
    session_id: str, workspace: Workspace, match: SourceMatch | None
) -> None:
    current = state.session
    if current is None or current.id != session_id:
        return
    try:
        result = await state.provider.analyze(
            error_text=current.error_text,
            path=match.path if match else None,
            source=workspace.context(match) if match else "",
        )
        location = workspace.location(match) if match else None
        analysis = Analysis(
            title=text_field(result.get("title"), "Possible root cause", 150),
            confidence="high" if match else "low",
            location=location,
            problem=text_field(result.get("problem"), "No supported explanation was returned"),
            evidence=text_field(result.get("evidence"), "The captured error was analyzed"),
            repair_strategy=text_field(
                result.get("repair_strategy"), "Review the error and source"
            ),
        )
        async with state.lock:
            if (
                state.session
                and state.session.id == session_id
                and state.session.stage == "analyzing"
            ):
                state.session.analysis = analysis
                state.session.stage = "root_cause_found"
                state.session.revision += 1
                state.persist()
    except ProviderError:
        async with state.lock:
            if state.session and state.session.id == session_id:
                state.session.stage = "analysis_failed"
                state.session.error_message = (
                    "Local AI is unavailable. Restore Ollama, then try again."
                )
                state.session.revision += 1
                state.persist()


@app.post("/api/sessions", status_code=202)
async def create_session(body: NewSessionRequest, _device: str = Depends(paired_only)) -> Session:
    if state.recovery_error:
        raise HTTPException(409, state.recovery_error)
    async with state.lock:
        workspace = state.workspace
        if workspace is None:
            raise HTTPException(409, "Select a project folder on the desktop first")
        if state.session and state.patched_sha is not None:
            if state.session.github_publish and state.session.github_publish.status == "pushed":
                # The verified fix is already part of Git history. Archive this
                # session and retain the source as-is; do not discard the commit.
                state.reset_session()
            else:
                raise HTTPException(409, "Undo the existing patch before starting another session")
        state.reset_session()
        match = workspace.locate(body.error_text)
        state.match = match
        created = Session(
            id=uuid.uuid4().hex,
            revision=1,
            stage="analyzing",
            source=body.source,
            error_text=body.error_text,
        )
        state.session = created
        state.persist()
        asyncio.create_task(analyze_in_background(created.id, workspace, match))
        return created.model_copy(deep=True)


async def propose_in_background(session_id: str, workspace: Workspace, match: SourceMatch) -> None:
    current = state.session
    if current is None or current.id != session_id or current.analysis is None:
        return
    try:
        result = await state.provider.propose(
            path=match.path,
            source=match.text,
            error_text=current.error_text,
            analysis=current.analysis.model_dump_json(),
        )
        old_text = result.get("old_text")
        new_text = result.get("new_text")
        if not isinstance(old_text, str) or not isinstance(new_text, str):
            raise TypeError("AI did not return a bounded replacement")
        if not old_text or len(old_text) > 5000 or len(new_text) > 6000:
            raise ValueError("AI replacement is empty or too large")
        if match.text.count(old_text) != 1 or old_text == new_text:
            raise ValueError("AI replacement did not match source exactly once")
        before = match.text[: match.text.index(old_text)]
        target_start_line = before.count("\n") + 1
        target_end_line = target_start_line + old_text.count("\n")
        if not (target_start_line - 5 <= match.line <= target_end_line + 5):
            raise ValueError("AI replacement is not near the reported error")
        new_source = match.text.replace(old_text, new_text, 1)
        if len(new_source.encode("utf-8")) > 80_000:
            raise ValueError("Patched file would exceed size limit")
        if match.path.endswith(".py"):
            compile(new_source, match.path, "exec")
        diff = "".join(
            difflib.unified_diff(
                match.text.splitlines(keepends=True),
                new_source.splitlines(keepends=True),
                fromfile=f"a/{match.path}",
                tofile=f"b/{match.path}",
            )
        )
        if not diff or len(diff) > 15_000:
            raise ValueError("Patch diff is empty or exceeds review limit")
        proposal = Proposal(
            id=uuid.uuid4().hex,
            title=text_field(result.get("title"), "Review a proposed fix", 150),
            summary=text_field(result.get("summary"), "A bounded source edit was prepared"),
            risk="medium",
            files=[ProposedFile(path=match.path, diff=diff)],
            why=text_field(result.get("why"), "The edit addresses the reported failure"),
            expected_effect=text_field(
                result.get("expected_effect"), "The selected test command will verify the change"
            ),
        )
        async with state.lock:
            if (
                state.session
                and state.session.id == session_id
                and state.session.stage == "generating_fix"
            ):
                state.proposed_bytes = new_source.encode("utf-8")
                state.session.proposal = proposal
                state.session.stage = "awaiting_approval"
                state.session.revision += 1
                state.persist()
    except (ProviderError, ValueError, TypeError, SyntaxError):
        async with state.lock:
            if state.session and state.session.id == session_id:
                state.session.stage = "failed"
                state.session.error_message = (
                    "No safe patch was generated. Review the error text and try analysis again."
                )
                state.session.revision += 1
                state.persist()


@app.post("/api/sessions/{session_id}/proposal", status_code=202)
async def generate_proposal(session_id: str, _device: str = Depends(paired_only)) -> Session:
    async with state.lock:
        current = active_session(session_id)
        if current.stage != "root_cause_found":
            raise HTTPException(409, "Analysis must finish before generating a fix")
        if state.workspace is None or state.match is None:
            raise HTTPException(422, "Error did not resolve to one safe repository file")
        current.stage = "generating_fix"
        current.revision += 1
        state.proposed_bytes = None
        state.persist()
        asyncio.create_task(propose_in_background(session_id, state.workspace, state.match))
        return current.model_copy(deep=True)


def atomic_write(path: Path, data: bytes) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=".pocketpilot-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, path.stat().st_mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@app.post("/api/sessions/{session_id}/approve")
async def approve(
    session_id: str, body: ApprovalRequest, _device: str = Depends(paired_only)
) -> Session:
    async with state.lock:
        current = active_session(session_id)
        match = state.match
        workspace = state.workspace
        if current.stage != "awaiting_approval" or current.proposal is None:
            raise HTTPException(409, "No patch is awaiting approval")
        if current.revision != body.revision or current.proposal.id != body.proposal_id:
            raise HTTPException(409, "Approval does not match the current proposal")
        if match is None or workspace is None or state.proposed_bytes is None:
            raise HTTPException(409, "Proposal data is no longer available")
        path = workspace.safe_file(match.path)
        original = path.read_bytes()
        if digest(original) != match.sha256:
            raise HTTPException(409, "Source changed after the proposal was generated")
        state.original_bytes = original
        state.patched_sha = digest(state.proposed_bytes)
        state.git_baseline = None
        try:
            state.git_baseline = await asyncio.to_thread(
                github_publisher.capture_baseline, workspace, match.path, match.sha256
            )
            current.github_publish = GitHubPublishState(
                status="waiting",
                repository=state.git_baseline.repository,
                branch=state.git_baseline.remote_branch,
                path=state.git_baseline.path,
                detail="Waiting for project checks to pass.",
            )
        except (GitPublishError, OSError) as exc:
            state.git_baseline = None
            detail = (
                str(exc)
                if isinstance(exc, GitPublishError)
                else "The Git repository could not be safely inspected on the laptop."
            )
            current.github_publish = GitHubPublishState(
                status="unavailable",
                path=match.path,
                detail=detail,
            )
        current.stage = "testing"
        current.revision += 1
        # Write the undo snapshot before touching source. Recovery compares both
        # hashes, so interruption on either side of the edit is unambiguous.
        state.persist()
        try:
            atomic_write(path, state.proposed_bytes)
        except OSError:
            state.patched_sha = None
            state.original_bytes = None
            current.stage = "failed"
            current.error_message = "The proposed fix could not be written; source was not changed."
            current.revision += 1
            state.persist()
            return current.model_copy(deep=True)
        result = current.model_copy(deep=True)
    # Fixed, project-detected argv only; never execute model text as a command.
    validation = await asyncio.to_thread(workspace.verify, match.path)
    async with state.lock:
        if state.session and state.session.id == session_id and state.session.stage == "testing":
            state.session.validation = validation
            state.session.stage = "verified" if validation.passed else "failed"
            if state.session.github_publish and state.session.github_publish.status == "waiting":
                if validation.passed and state.git_baseline:
                    state.session.github_publish.status = "ready"
                    state.session.github_publish.detail = "Checks passed. Review the destination and explicitly confirm from the phone to publish."
                else:
                    state.session.github_publish.status = "unavailable"
                    state.session.github_publish.detail = (
                        "Publishing is available only after the selected project checks pass."
                    )
            state.session.error_message = (
                None if validation.passed else "Validation failed; review or undo the patch."
            )
            state.session.revision += 1
            state.persist()
            result = state.session.model_copy(deep=True)
    return result


@app.post("/api/sessions/{session_id}/undo")
async def undo(session_id: str, body: UndoRequest, _device: str = Depends(paired_only)) -> Session:
    async with state.lock:
        current = active_session(session_id)
        if current.revision != body.revision:
            raise HTTPException(409, "Undo does not match the current session")
        if current.stage not in {"verified", "failed"}:
            raise HTTPException(409, "No applied patch can be undone at this stage")
        if current.github_publish and (
            current.github_publish.status
            in {
                "awaiting_desktop_confirmation",
                "committing",
                "pushing",
                "pushed",
                "commit_failed",
                "upload_failed",
            }
            or current.github_publish.commit_sha
        ):
            raise HTTPException(
                409,
                "A GitHub commit may exist or be pending; inspect the desktop publish state before undoing",
            )
        if (
            state.workspace is None
            or state.match is None
            or state.original_bytes is None
            or state.patched_sha is None
        ):
            raise HTTPException(409, "No applied patch snapshot is available")
        path = state.workspace.safe_file(state.match.path)
        if digest(path.read_bytes()) != state.patched_sha:
            raise HTTPException(409, "Source changed after the fix; automatic undo is unsafe")
        atomic_write(path, state.original_bytes)
        state.patched_sha = None
        state.git_baseline = None
        current.stage = "undone"
        current.revision += 1
        state.persist()
        return current.model_copy(deep=True)


@app.post("/api/sessions/{session_id}/github/publish")
async def request_verified_publish(
    session_id: str,
    body: GitHubPublishRequest,
    _device: str = Depends(paired_only),
) -> Session:
    try:
        message = commit_message(body.message)
    except GitPublishError as exc:
        raise HTTPException(422, str(exc)) from exc

    async with state.lock:
        current = active_session(session_id)
        publish = current.github_publish
        if (
            current.stage != "verified"
            or current.validation is None
            or not current.validation.passed
        ):
            raise HTTPException(
                409, "GitHub publish is available only after the approved fix passes its checks"
            )
        if current.revision != body.revision:
            raise HTTPException(
                409, "The verified session changed; review it again before publishing"
            )
        if state.workspace is None or state.match is None or state.patched_sha is None:
            raise HTTPException(409, "The verified source snapshot is no longer available")
        if state.git_baseline is None or publish is None:
            raise HTTPException(
                409,
                publish.detail if publish and publish.detail else "GitHub publish is unavailable",
            )
        if publish.status in {"awaiting_desktop_confirmation", "committing", "pushing"}:
            raise HTTPException(409, "A GitHub publish action is already running")
        if publish.status not in {"ready", "commit_failed", "upload_failed"}:
            if publish.status == "pushed":
                return current.model_copy(deep=True)
            raise HTTPException(409, "This session is not ready for a GitHub publish action")
        if publish.message and publish.message != message:
            raise HTTPException(
                409, "This publish request already has a fixed message; retry must reuse it"
            )
        publish.status = "awaiting_desktop_confirmation"
        publish.message = publish.message or message
        publish.detail = (
            "Phone request received. Review the exact destination on the laptop dashboard "
            "and confirm there before Git creates or uploads a commit."
        )
        current.revision += 1
        state.persist()
        return current.model_copy(deep=True)


async def perform_publish(session_id: str, expected_revision: int) -> Session:
    async with state.lock:
        current = active_session(session_id)
        publish = current.github_publish
        if current.stage != "verified" or not current.validation or not current.validation.passed:
            raise HTTPException(409, "Only a verified fix can be published")
        if current.revision != expected_revision:
            raise HTTPException(409, "The session changed; refresh and review it again")
        if publish is None or publish.status != "awaiting_desktop_confirmation":
            raise HTTPException(409, "There is no phone publish request awaiting confirmation")
        if state.workspace is None or state.match is None or state.patched_sha is None:
            raise HTTPException(409, "The verified source snapshot is no longer available")
        if state.git_baseline is None:
            raise HTTPException(409, "The GitHub destination is no longer available")
        workspace = state.workspace
        baseline = state.git_baseline
        patched_sha = state.patched_sha
        fixed_message = publish.message
        prior_commit = publish.commit_sha
        publish.status = "committing"
        publish.detail = "Laptop confirmation received. Preparing the exact one-file commit."
        current.revision += 1
        operation_revision = current.revision
        state.persist()

    try:
        commit = await asyncio.to_thread(
            github_publisher.prepare_commit,
            workspace,
            baseline,
            patched_sha,
            session_id,
            fixed_message or "Fix verified issue",
        )
        if prior_commit and commit != prior_commit:
            raise GitPublishError(
                "The retry did not resolve to the original verified commit; upload was stopped.",
                commit_sha=commit,
            )
    except GitPublishError as exc:
        async with state.lock:
            current = active_session(session_id)
            if current.github_publish:
                current.github_publish.status = "commit_failed"
                current.github_publish.commit_sha = (
                    exc.commit_sha or current.github_publish.commit_sha
                )
                current.github_publish.detail = str(exc)
                current.revision += 1
                state.persist()
            return current.model_copy(deep=True)

    async with state.lock:
        current = active_session(session_id)
        publish = current.github_publish
        if (
            current.stage != "verified"
            or current.revision != operation_revision
            or publish is None
            or publish.status != "committing"
        ):
            if publish:
                publish.status = "commit_failed"
                publish.commit_sha = commit
                publish.detail = (
                    "The session changed during commit; inspect this local commit before retrying."
                )
                current.revision += 1
                state.persist()
            raise HTTPException(
                409, "The verified session changed during commit; no upload was attempted"
            )
        publish.commit_sha = commit
        publish.status = "pushing"
        publish.detail = "Commit created locally. Checking the GitHub branch before upload."
        current.revision += 1
        operation_revision = current.revision
        state.persist()

    try:
        await asyncio.to_thread(github_publisher.push_commit, workspace, baseline, commit)
    except GitPublishError as exc:
        async with state.lock:
            current = active_session(session_id)
            if current.github_publish:
                current.github_publish.status = "upload_failed"
                current.github_publish.commit_sha = commit
                current.github_publish.detail = str(exc)
                current.revision += 1
                state.persist()
            return current.model_copy(deep=True)

    async with state.lock:
        current = active_session(session_id)
        if current.github_publish and current.revision == operation_revision:
            current.github_publish.status = "pushed"
            current.github_publish.detail = (
                "GitHub confirmed this exact commit on the selected branch."
            )
            current.revision += 1
            state.persist()
        return current.model_copy(deep=True)


@app.post(
    "/api/sessions/{session_id}/github/publish/confirm",
    dependencies=[Depends(loopback_only)],
)
async def confirm_publish(session_id: str, body: PublishConfirmationRequest) -> Session:
    return await perform_publish(session_id, body.revision)
