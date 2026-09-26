"""Bounded, privacy-preserving local history of completed debug sessions."""

import json
import os
import tempfile
import time
from pathlib import Path

from .models import Session, SessionHistoryItem

MAX_HISTORY_ITEMS = 25
MAX_HISTORY_BYTES = 256_000


def default_path() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local" / "share")
    return base / "PocketPilotCityBattle" / "session-history.json"


class SessionHistoryStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or default_path()
        self.items: list[SessionHistoryItem] = []
        self.last_error: str | None = None
        try:
            self.items = self._load()
        except (OSError, ValueError, TypeError, KeyError) as exc:
            # History is helpful, but a damaged history file must not prevent
            # the debugger or recovery journal from starting.
            self.last_error = f"Session history could not be loaded: {exc}"

    def _load(self) -> list[SessionHistoryItem]:
        if not self.path.is_file():
            return []
        if self.path.stat().st_size > MAX_HISTORY_BYTES:
            raise ValueError("history file exceeds size limit")
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(payload, list):
            raise TypeError("history file is not a list")
        items = [SessionHistoryItem.model_validate(item) for item in payload[-MAX_HISTORY_ITEMS:]]
        return items

    def record(self, session: Session) -> None:
        if session.stage not in {"analysis_failed", "verified", "failed", "undone"}:
            return
        previous = next((item for item in self.items if item.id == session.id), None)
        item = SessionHistoryItem(
            id=session.id,
            stage=session.stage,
            source=session.source,
            title={
                "analysis_failed": "Analysis needs attention",
                "verified": "Fix verified",
                "failed": "Fix needs attention",
                "undone": "Fix undone",
            }[session.stage],
            location=session.analysis.location if session.analysis else None,
            check_passed=session.validation.passed if session.validation else None,
            check_command=session.validation.command if session.validation else None,
            updated_at=int(time.time()),
            github_status=session.github_publish.status if session.github_publish else None,
            repository=session.github_publish.repository if session.github_publish else None,
            branch=session.github_publish.branch if session.github_publish else None,
            commit_sha=session.github_publish.commit_sha if session.github_publish else None,
        )
        if previous:
            item.updated_at = (
                previous.updated_at if previous.stage == item.stage else item.updated_at
            )
            if item == previous:
                return
            self.items = [existing for existing in self.items if existing.id != item.id]
        self.items.insert(0, item)
        self.items = self.items[:MAX_HISTORY_ITEMS]
        try:
            self._save()
            self.last_error = None
        except OSError as exc:
            self.last_error = f"Session history could not be saved: {exc}"

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(
            prefix=".pocketpilot-history-", dir=self.path.parent
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump([item.model_dump(mode="json") for item in self.items], stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
