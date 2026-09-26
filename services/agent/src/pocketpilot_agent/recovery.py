"""Local, atomic recovery record for the selected session and approved edit.

The record is deliberately outside the selected project. It contains error text
and a pre-edit file snapshot, so it must never be checked into the repository.
"""

import base64
import binascii
import json
import os
import tempfile
from pathlib import Path

from .github_publish import GitBaseline
from .models import Session
from .workspace import SourceMatch, Workspace, digest


def default_path() -> Path:
    override = os.environ.get("POCKETPILOT_RECOVERY_PATH")
    if override:
        return Path(override).expanduser().resolve()
    base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local" / "share")
    return base / "PocketPilotCityBattle" / "agent-recovery.json"


def encode_bytes(value: bytes | None) -> str | None:
    return base64.b64encode(value).decode("ascii") if value is not None else None


def decode_bytes(value: object) -> bytes | None:
    if not isinstance(value, str):
        return None
    try:
        return base64.b64decode(value, validate=True)
    except binascii.Error as exc:
        raise ValueError("Recovery bytes are invalid") from exc


class RecoveryStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or default_path()

    def save(
        self,
        workspace: Workspace | None,
        session: Session | None,
        match: SourceMatch | None,
        proposed_bytes: bytes | None,
        original_bytes: bytes | None,
        patched_sha: str | None,
        git_baseline: GitBaseline | None = None,
    ) -> None:
        document = {
            "version": 2,
            "workspace": str(workspace.root) if workspace else None,
            "session": session.model_dump(mode="json") if session else None,
            "match": {
                "path": match.path,
                "line": match.line,
                "text": match.text,
                "sha256": match.sha256,
            }
            if match
            else None,
            "proposed_bytes": encode_bytes(proposed_bytes),
            "original_bytes": encode_bytes(original_bytes),
            "patched_sha": patched_sha,
            "git_baseline": git_baseline.model_dump(mode="json") if git_baseline else None,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(
            prefix=".pocketpilot-recovery-", dir=self.path.parent
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(document, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def load(
        self,
    ) -> tuple[
        Workspace | None,
        Session | None,
        SourceMatch | None,
        bytes | None,
        bytes | None,
        str | None,
        GitBaseline | None,
    ]:
        if not self.path.is_file():
            return None, None, None, None, None, None, None
        if self.path.stat().st_size > 1_000_000:
            raise ValueError("Recovery record exceeds size limit")
        document = json.loads(self.path.read_text(encoding="utf-8"))
        if document.get("version") not in {1, 2}:
            raise ValueError("Unsupported recovery record")
        workspace = Workspace(document["workspace"]) if document.get("workspace") else None
        session = Session.model_validate(document["session"]) if document.get("session") else None
        record = document.get("match")
        match = SourceMatch(**record) if record else None
        proposed = decode_bytes(document.get("proposed_bytes"))
        original = decode_bytes(document.get("original_bytes"))
        patched_sha = document.get("patched_sha")
        git_baseline = (
            GitBaseline.model_validate(document["git_baseline"])
            if document.get("git_baseline")
            else None
        )
        if match and workspace:
            workspace.safe_file(match.path)
            if digest(match.text.encode("utf-8")) != match.sha256:
                raise ValueError("Recovery source hash is invalid")
        if patched_sha:
            if not (workspace and match and original and proposed and session):
                raise ValueError("Applied patch recovery record is incomplete")
            if digest(original) != match.sha256 or digest(proposed) != patched_sha:
                raise ValueError("Applied patch recovery hashes are invalid")
        if git_baseline:
            if not (workspace and match and session and patched_sha):
                raise ValueError("GitHub publish recovery record is incomplete")
            if git_baseline.path != match.path or git_baseline.original_sha != match.sha256:
                raise ValueError("GitHub publish recovery does not match the approved source")
        return workspace, session, match, proposed, original, patched_sha, git_baseline
