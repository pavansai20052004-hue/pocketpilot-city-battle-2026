"""GitHub publishing is bounded to an exact, verified source-file commit."""

import subprocess
from pathlib import Path

import pytest

from pocketpilot_agent.github_publish import (
    GitHubPublisher,
    GitPublishError,
    _CommandResult,
    _github_repository,
    commit_message,
)
from pocketpilot_agent.workspace import Workspace, digest

REMOTE_URL = "https://github.com/pavansai20052004-hue/pocketpilot-city-battle-2026.git"


def git(root: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments], cwd=root, check=True, capture_output=True, text=True
    )
    return result.stdout.strip()


def repository(root: Path) -> tuple[Workspace, str, str]:
    root.mkdir(parents=True, exist_ok=True)
    git(root, "init", "-b", "main")
    git(root, "config", "user.name", "PocketPilot Test")
    git(root, "config", "user.email", "pocketpilot-test@example.invalid")
    source = root / "src" / "service.py"
    source.parent.mkdir(parents=True)
    source.write_text("def total(value, percent):\n    return value * percent\n", encoding="utf-8")
    test_file = root / "tests" / "test_service.py"
    test_file.parent.mkdir()
    test_file.write_text("def test_example():\n    assert True\n", encoding="utf-8")
    git(root, "add", "--", "src/service.py", "tests/test_service.py")
    git(root, "commit", "-m", "Initial project")
    git(root, "remote", "add", "origin", REMOTE_URL)
    git(root, "config", "branch.main.remote", "origin")
    git(root, "config", "branch.main.merge", "refs/heads/main")
    return Workspace(str(root)), "src/service.py", git(root, "rev-parse", "HEAD")


def test_github_remote_parser_accepts_only_github_shapes():
    assert _github_repository(REMOTE_URL) == "pavansai20052004-hue/pocketpilot-city-battle-2026"
    assert _github_repository("git@github.com:owner/project.git") == "owner/project"
    assert _github_repository("ssh://git@github.com/owner/project") == "owner/project"
    assert _github_repository("https://user:token@github.com/owner/project") is None
    assert _github_repository("https://github.com.evil.test/owner/project") is None
    assert _github_repository("file:///tmp/project") is None


def test_commit_message_rejects_controls_and_limits_length():
    assert commit_message("  Fix   null handling  ") == "Fix null handling"
    with pytest.raises(GitPublishError):
        commit_message("first line\nsecond line")
    with pytest.raises(GitPublishError):
        commit_message("x" * 73)


def test_publish_commit_contains_exactly_one_verified_file_and_retry_is_idempotent(tmp_path):
    workspace, path, original_head = repository(tmp_path / "repo")
    source = workspace.safe_file(path)
    original_sha = digest(source.read_bytes())
    publisher = GitHubPublisher()
    baseline = publisher.capture_baseline(workspace, path, original_sha)
    assert baseline.head == original_head
    assert baseline.repository == "pavansai20052004-hue/pocketpilot-city-battle-2026"

    source.write_text(
        "def total(value, percent):\n    if percent is None:\n        return value\n    return value * percent\n",
        encoding="utf-8",
    )
    patched_sha = digest(source.read_bytes())
    first = publisher.prepare_commit(
        workspace, baseline, patched_sha, "session-123", "Handle null percent"
    )
    second = publisher.prepare_commit(
        workspace, baseline, patched_sha, "session-123", "Handle null percent"
    )

    assert second == first
    assert git(Path(baseline.root), "rev-parse", "HEAD") == first
    assert git(Path(baseline.root), "rev-parse", f"{first}^") == original_head
    assert (
        git(Path(baseline.root), "diff-tree", "--no-commit-id", "--name-only", "-r", first) == path
    )
    assert "PocketPilot-Session: session-123" in git(
        Path(baseline.root), "show", "-s", "--format=%B", first
    )
    assert git(Path(baseline.root), "status", "--porcelain") == ""


def test_publish_baseline_refuses_dirty_repository(tmp_path):
    workspace, path, _ = repository(tmp_path / "repo")
    workspace.safe_file("tests/test_service.py").write_text("# local edit\n", encoding="utf-8")
    with pytest.raises(GitPublishError, match="local changes"):
        GitHubPublisher().capture_baseline(
            workspace, path, digest(workspace.safe_file(path).read_bytes())
        )


def test_publish_preview_refuses_unrelated_untracked_file(tmp_path):
    workspace, path, _ = repository(tmp_path / "repo")
    source = workspace.safe_file(path)
    original_sha = digest(source.read_bytes())
    publisher = GitHubPublisher()
    baseline = publisher.capture_baseline(workspace, path, original_sha)
    source.write_text(source.read_text(encoding="utf-8") + "\n# approved edit\n", encoding="utf-8")
    patched_sha = digest(source.read_bytes())
    (Path(baseline.root) / "unrelated.txt").write_text("keep me", encoding="utf-8")
    with pytest.raises(GitPublishError, match="Only the approved source-file"):
        publisher.validate_preview(workspace, baseline, patched_sha)


def test_push_refuses_remote_advance_without_attempting_push(tmp_path, monkeypatch):
    workspace, path, _ = repository(tmp_path / "repo")
    source = workspace.safe_file(path)
    baseline = GitHubPublisher().capture_baseline(workspace, path, digest(source.read_bytes()))
    source.write_text(source.read_text(encoding="utf-8") + "\n# verified\n", encoding="utf-8")
    publisher = GitHubPublisher()
    commit = publisher.prepare_commit(
        workspace, baseline, digest(source.read_bytes()), "session-456", "Fix verified issue"
    )
    calls: list[tuple[str, ...]] = []

    def fake_try(_root: Path, *arguments: str, timeout: int = 20) -> _CommandResult:
        calls.append(arguments)
        if arguments[0] == "ls-remote":
            return _CommandResult(f"{'a' * 40}\trefs/heads/main", "", 0)
        raise AssertionError(f"Unexpected Git command: {arguments}")

    monkeypatch.setattr(publisher, "_try", fake_try)
    with pytest.raises(GitPublishError, match="branch no longer matches"):
        publisher.push_commit(workspace, baseline, commit)
    assert all(arguments[0] != "push" for arguments in calls)


def test_publish_pushes_exact_commit_to_local_test_remote_and_retry_is_safe(tmp_path, monkeypatch):
    workspace, path, original_head = repository(tmp_path / "repo")
    bare = tmp_path / "remote.git"
    git(tmp_path, "init", "--bare", "--initial-branch=main", str(bare))
    git(Path(workspace.root), "push", str(bare), f"{original_head}:refs/heads/main")
    git(Path(workspace.root), "remote", "set-url", "origin", str(bare))

    publisher = GitHubPublisher()
    monkeypatch.setattr(
        publisher,
        "_remote_repository",
        lambda _root, _remote: "pavansai20052004-hue/pocketpilot-city-battle-2026",
    )
    source = workspace.safe_file(path)
    baseline = publisher.capture_baseline(workspace, path, digest(source.read_bytes()))
    source.write_text(source.read_text(encoding="utf-8") + "\n# verified\n", encoding="utf-8")
    commit = publisher.prepare_commit(
        workspace, baseline, digest(source.read_bytes()), "session-push", "Fix verified issue"
    )

    publisher.push_commit(workspace, baseline, commit)
    publisher.push_commit(workspace, baseline, commit)
    assert git(bare, "rev-parse", "refs/heads/main") == commit


def test_recovery_baseline_round_trips_and_legacy_record_loads(tmp_path):
    import json

    from pocketpilot_agent.models import Session
    from pocketpilot_agent.recovery import RecoveryStore

    workspace, path, _ = repository(tmp_path / "repo")
    source = workspace.safe_file(path)
    original = source.read_bytes()
    match = workspace.locate("src/service.py:1")
    assert match is not None
    baseline = GitHubPublisher().capture_baseline(workspace, path, digest(original))
    proposed = original + b"\n# verified\n"
    session = Session(
        id="recovery-publish", revision=2, stage="testing", source="text", error_text="TypeError"
    )
    recovery = RecoveryStore(tmp_path / "recovery.json")
    recovery.save(workspace, session, match, proposed, original, digest(proposed), baseline)
    loaded = recovery.load()
    assert loaded[0] is not None
    assert loaded[1] is not None and loaded[1].id == session.id
    assert loaded[6] == baseline

    legacy = RecoveryStore(tmp_path / "legacy.json")
    legacy.path.write_text(
        json.dumps(
            {
                "version": 1,
                "workspace": None,
                "session": None,
                "match": None,
                "proposed_bytes": None,
                "original_bytes": None,
                "patched_sha": None,
            }
        ),
        encoding="utf-8",
    )
    assert legacy.load() == (None, None, None, None, None, None, None)
