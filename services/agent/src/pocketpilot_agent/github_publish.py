"""Explicit, single-file GitHub publishing for a verified repair.

Git and its credential manager stay on the laptop. The phone supplies only a
short commit message and the revision it reviewed; it never supplies a URL,
refspec, command, or credential.
"""

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import BaseModel

from .workspace import Workspace, digest

GIT_TIMEOUT_SECONDS = 20
PUSH_TIMEOUT_SECONDS = 120
REMOTE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
BRANCH_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
GITHUB_SCP_URL = re.compile(r"^git@github\.com:([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?$")
OBJECT_ID = re.compile(r"^[0-9a-f]{40,64}$")


class GitPublishError(RuntimeError):
    """A safe, user-facing Git publishing refusal or failure."""

    def __init__(self, message: str, *, commit_sha: str | None = None) -> None:
        super().__init__(message)
        self.commit_sha = commit_sha


class _GitCommandError(GitPublishError):
    """Git failure retaining output only for in-process classification."""

    def __init__(self, stdout: str, stderr: str, returncode: int) -> None:
        super().__init__("Could not safely inspect or update this Git repository.")
        self.output = f"{stdout}\n{stderr}".lower()
        self.returncode = returncode


@dataclass(frozen=True)
class _CommandResult:
    stdout: str
    stderr: str
    returncode: int


class GitBaseline(BaseModel):
    root: str
    head: str
    branch: str
    remote: str
    remote_branch: str
    repository: str
    path: str
    original_sha: str


def _github_repository(remote_url: str) -> str | None:
    """Return owner/repo only for a narrowly supported GitHub URL shape."""
    scp_match = GITHUB_SCP_URL.fullmatch(remote_url)
    if scp_match:
        owner, repository = scp_match.groups()
        repository = repository.removesuffix(".git")
    else:
        try:
            parsed = urlsplit(remote_url)
            if parsed.scheme == "https":
                if (
                    parsed.username
                    or parsed.password
                    or parsed.port
                    or parsed.query
                    or parsed.fragment
                ):
                    return None
                if parsed.hostname != "github.com":
                    return None
            elif parsed.scheme == "ssh":
                if (
                    parsed.hostname != "github.com"
                    or parsed.username != "git"
                    or parsed.password
                    or parsed.port not in (None, 22)
                    or parsed.query
                    or parsed.fragment
                ):
                    return None
            else:
                return None
            segments = parsed.path.strip("/").split("/")
            if len(segments) != 2:
                return None
            owner, repository = segments
            repository = repository.removesuffix(".git")
        except ValueError:
            return None
    if (
        not owner
        or not repository
        or owner in {".", ".."}
        or repository in {".", ".."}
        or not re.fullmatch(r"[A-Za-z0-9_.-]+", owner)
        or not re.fullmatch(r"[A-Za-z0-9_.-]+", repository)
    ):
        return None
    return f"{owner}/{repository}"


class GitHubPublisher:
    def _execute(
        self, root: Path, *arguments: str, timeout: int = GIT_TIMEOUT_SECONDS
    ) -> _CommandResult:
        git = shutil.which("git")
        if not git:
            raise GitPublishError("Git is not installed on the laptop.")
        try:
            result = subprocess.run(
                [git, *arguments],
                cwd=root,
                env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "Never"},
                shell=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise GitPublishError(
                "Git did not respond in time. Check the laptop and try again."
            ) from exc
        except OSError as exc:
            raise GitPublishError("Git could not start on the laptop.") from exc
        # Keep NUL delimiters intact: Git's -z formats use them as record boundaries.
        return _CommandResult(
            result.stdout.rstrip("\r\n"), result.stderr.rstrip("\r\n"), result.returncode
        )

    def _run(self, root: Path, *arguments: str, timeout: int = GIT_TIMEOUT_SECONDS) -> str:
        result = self._execute(root, *arguments, timeout=timeout)
        if result.returncode:
            raise _GitCommandError(result.stdout, result.stderr, result.returncode)
        return result.stdout

    def _try(
        self, root: Path, *arguments: str, timeout: int = GIT_TIMEOUT_SECONDS
    ) -> _CommandResult:
        return self._execute(root, *arguments, timeout=timeout)

    def _remote_repository(self, root: Path, remote: str) -> str:
        if not REMOTE_NAME.fullmatch(remote):
            raise GitPublishError("The configured GitHub remote name is invalid.")
        fetch_urls = self._run(root, "remote", "get-url", "--all", remote).splitlines()
        push_urls = self._run(root, "remote", "get-url", "--push", "--all", remote).splitlines()
        if len(fetch_urls) != 1 or len(push_urls) != 1:
            raise GitPublishError("This repository has multiple URLs for its GitHub remote.")
        fetch_repo = _github_repository(fetch_urls[0].strip())
        push_repo = _github_repository(push_urls[0].strip())
        if not fetch_repo or not push_repo or fetch_repo.casefold() != push_repo.casefold():
            raise GitPublishError(
                "The selected remote must use the same GitHub repository for fetch and push."
            )
        return fetch_repo

    def _select_remote(self, root: Path, branch: str) -> tuple[str, str, str]:
        remote_result = self._try(root, "config", "--get", f"branch.{branch}.remote")
        merge_result = self._try(root, "config", "--get", f"branch.{branch}.merge")
        remote_setting = remote_result.stdout.strip() if remote_result.returncode == 0 else ""
        merge_setting = merge_result.stdout.strip() if merge_result.returncode == 0 else ""
        if remote_setting or merge_setting:
            if (
                not remote_setting
                or remote_setting == "."
                or not merge_setting.startswith("refs/heads/")
            ):
                raise GitPublishError(
                    "The current branch has an incomplete upstream configuration."
                )
            remote_branch = merge_setting.removeprefix("refs/heads/")
            if not BRANCH_NAME.fullmatch(remote_branch):
                raise GitPublishError("The current branch has an invalid GitHub upstream.")
            check = self._try(root, "check-ref-format", "refs/heads/" + remote_branch)
            if check.returncode:
                raise GitPublishError("The current branch has an invalid GitHub upstream.")
            return remote_setting, remote_branch, self._remote_repository(root, remote_setting)

        valid_remotes: list[tuple[str, str]] = []
        for remote in self._run(root, "remote").splitlines():
            remote = remote.strip()
            try:
                valid_remotes.append((remote, self._remote_repository(root, remote)))
            except GitPublishError:
                continue
        if len(valid_remotes) != 1:
            raise GitPublishError(
                "Set this branch's upstream on the laptop so PocketPilot can identify one GitHub destination."
            )
        remote, repository = valid_remotes[0]
        return remote, branch, repository

    def _head_and_branch(self, root: Path, baseline: GitBaseline) -> None:
        if self._run(root, "rev-parse", "--verify", "HEAD") != baseline.head:
            raise GitPublishError(
                "The Git branch advanced after verification; publish is paused for review."
            )
        branch = self._run(root, "symbolic-ref", "--quiet", "--short", "HEAD")
        if branch != baseline.branch:
            raise GitPublishError("The active Git branch changed after verification.")

    def capture_baseline(self, workspace: Workspace, path: str, original_sha: str) -> GitBaseline:
        root_output = self._run(workspace.root, "rev-parse", "--show-toplevel")
        root = Path(root_output).resolve(strict=True)
        if root != workspace.root:
            raise GitPublishError(
                "Select the Git repository root as the PocketPilot workspace to publish."
            )
        if self._run(root, "status", "--porcelain=v1", "-z", "--untracked-files=all"):
            raise GitPublishError(
                "GitHub publish is disabled while this repository has local changes."
            )
        branch = self._run(root, "symbolic-ref", "--quiet", "--short", "HEAD")
        if not BRANCH_NAME.fullmatch(branch):
            raise GitPublishError("GitHub publish is disabled for this branch name.")
        head = self._run(root, "rev-parse", "--verify", "HEAD")
        if not OBJECT_ID.fullmatch(head):
            raise GitPublishError("Git could not identify the current commit safely.")
        tracked = self._run(root, "ls-files", "--error-unmatch", "--", path)
        if tracked.replace("\\", "/") != path:
            raise GitPublishError("Only a tracked source file can be published from PocketPilot.")
        if digest(workspace.safe_file(path).read_bytes()) != original_sha:
            raise GitPublishError("The source changed before GitHub publish was prepared.")
        remote, remote_branch, repository = self._select_remote(root, branch)
        return GitBaseline(
            root=str(root),
            head=head,
            branch=branch,
            remote=remote,
            remote_branch=remote_branch,
            repository=repository,
            path=path,
            original_sha=original_sha,
        )

    def validate_preview(
        self, workspace: Workspace, baseline: GitBaseline, patched_sha: str
    ) -> None:
        root = Path(baseline.root).resolve(strict=True)
        if (
            root != workspace.root
            or root != Path(self._run(root, "rev-parse", "--show-toplevel")).resolve()
        ):
            raise GitPublishError("The selected Git repository changed after the fix was prepared.")
        self._head_and_branch(root, baseline)
        status = self._run(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
        if status.split("\0") != [f" M {baseline.path}", ""]:
            raise GitPublishError(
                "The repository changed after verification. Only the approved source-file change may be published."
            )
        if digest(workspace.safe_file(baseline.path).read_bytes()) != patched_sha:
            raise GitPublishError("The verified source file changed. Re-verify before publishing.")
        remote, remote_branch, repository = self._select_remote(root, baseline.branch)
        if (
            remote != baseline.remote
            or remote_branch != baseline.remote_branch
            or repository.casefold() != baseline.repository.casefold()
        ):
            raise GitPublishError("The GitHub destination changed after verification.")

    def _existing_session_commit(
        self, workspace: Workspace, baseline: GitBaseline, patched_sha: str, session_id: str
    ) -> str | None:
        root = Path(baseline.root)
        output = self._run(
            root,
            "log",
            "-1",
            "--format=%H%x00%P%x00%B",
            "--",
            baseline.path,
        )
        parts = output.split("\0", 2)
        if len(parts) != 3 or f"PocketPilot-Session: {session_id}" not in parts[2].splitlines():
            return None
        commit = parts[0].strip()
        parents = parts[1].split()
        if (
            not OBJECT_ID.fullmatch(commit)
            or parents != [baseline.head]
            or self._run(root, "rev-parse", "--verify", "HEAD") != commit
            or self._run(
                root, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit
            ).split("\0")
            != [baseline.path, ""]
            or self._run(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
            or digest(workspace.safe_file(baseline.path).read_bytes()) != patched_sha
        ):
            raise GitPublishError(
                "A previous publish attempt left a different local commit; review Git before retrying.",
                commit_sha=commit,
            )
        blob = self._run(root, "rev-parse", "--verify", f"{commit}:{baseline.path}")
        worktree_blob = self._run(
            root, "hash-object", f"--path={baseline.path}", str(workspace.safe_file(baseline.path))
        )
        if blob != worktree_blob:
            raise GitPublishError(
                "The local commit does not contain the exact verified source file."
            )
        return commit

    def prepare_commit(
        self,
        workspace: Workspace,
        baseline: GitBaseline,
        patched_sha: str,
        session_id: str,
        message: str,
    ) -> str:
        # A retry after a timeout/restart must reuse the exact same commit.
        existing = self._existing_session_commit(workspace, baseline, patched_sha, session_id)
        if existing:
            return existing
        self.validate_preview(workspace, baseline, patched_sha)
        root = Path(baseline.root)
        self._run(root, "add", "--", baseline.path)
        staged = self._run(root, "diff", "--cached", "--name-only", "-z")
        if staged.split("\0") != [baseline.path, ""]:
            self._try(root, "reset", "--quiet", "HEAD", "--", baseline.path)
            raise GitPublishError("The staged change is not limited to the approved source file.")
        staged_check = self._try(root, "diff", "--cached", "--check")
        if staged_check.returncode:
            self._try(root, "reset", "--quiet", "HEAD", "--", baseline.path)
            raise GitPublishError(
                "The verified patch contains whitespace errors; no commit was created."
            )
        # Configured laptop Git hooks may run during commit; the phone tells the
        # user this before confirmation. No hook is bypassed by PocketPilot.
        self._run(
            root,
            "commit",
            "--only",
            "-m",
            message,
            "-m",
            f"PocketPilot-Session: {session_id}",
            "--",
            baseline.path,
        )
        commit = self._run(root, "rev-parse", "--verify", "HEAD")
        parents = self._run(root, "rev-list", "--parents", "-n", "1", commit).split()
        changed = self._run(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit)
        status = self._run(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
        if (
            parents != [commit, baseline.head]
            or changed.split("\0") != [baseline.path, ""]
            or status
            or digest(workspace.safe_file(baseline.path).read_bytes()) != patched_sha
        ):
            raise GitPublishError(
                "The local commit did not match the verified one-file change; no push was attempted.",
                commit_sha=commit,
            )
        return commit

    def push_commit(self, workspace: Workspace, baseline: GitBaseline, commit_sha: str) -> None:
        root = Path(baseline.root).resolve(strict=True)
        if root != workspace.root:
            raise GitPublishError("The selected Git repository changed; push is paused.")
        if not OBJECT_ID.fullmatch(commit_sha):
            raise GitPublishError("The verified commit identifier is invalid; upload was stopped.")
        if self._run(root, "rev-parse", "--verify", "HEAD") != commit_sha:
            raise GitPublishError(
                "The local branch changed. PocketPilot will not push a different commit."
            )
        branch = self._run(root, "symbolic-ref", "--quiet", "--short", "HEAD")
        if branch != baseline.branch:
            raise GitPublishError(
                "The active branch changed. PocketPilot will not push to another branch."
            )
        if (
            self._remote_repository(root, baseline.remote).casefold()
            != baseline.repository.casefold()
        ):
            raise GitPublishError(
                "The GitHub destination changed. PocketPilot will not push there."
            )
        remote_ref = f"refs/heads/{baseline.remote_branch}"
        remote_result = self._try(
            root, "ls-remote", "--heads", baseline.remote, remote_ref, timeout=PUSH_TIMEOUT_SECONDS
        )
        if remote_result.returncode:
            raise self._safe_push_error(
                remote_result.stdout, remote_result.stderr, remote_result.returncode
            )
        remote_lines = remote_result.stdout.splitlines()
        remote_sha = remote_lines[0].split()[0] if remote_lines else None
        if remote_sha == commit_sha:
            return
        if remote_sha != baseline.head:
            raise GitPublishError(
                "GitHub's branch no longer matches the verified starting commit. Review the remote before retrying."
            )
        pushed = self._try(
            root,
            "push",
            "--porcelain",
            baseline.remote,
            f"{commit_sha}:{remote_ref}",
            timeout=PUSH_TIMEOUT_SECONDS,
        )
        if pushed.returncode:
            raise self._safe_push_error(pushed.stdout, pushed.stderr, pushed.returncode)
        confirmed = self._try(
            root, "ls-remote", "--heads", baseline.remote, remote_ref, timeout=PUSH_TIMEOUT_SECONDS
        )
        confirmed_lines = confirmed.stdout.splitlines()
        if (
            confirmed.returncode
            or not confirmed_lines
            or confirmed_lines[0].split()[0] != commit_sha
        ):
            raise GitPublishError(
                "GitHub did not confirm the new commit. It remains local; check the remote and retry."
            )

    @staticmethod
    def _safe_push_error(stdout: str, stderr: str, returncode: int) -> GitPublishError:
        output = f"{stdout}\n{stderr}".lower()
        if any(
            term in output for term in ("non-fast-forward", "fetch first", "rejected", "stale info")
        ):
            return GitPublishError(
                "GitHub rejected the update because the remote branch changed. No force-push was attempted."
            )
        if any(
            term in output
            for term in (
                "authentication failed",
                "could not read username",
                "publickey",
                "permission denied",
            )
        ):
            return GitPublishError(
                "GitHub sign-in or write access is missing on the laptop. Sign in there, then retry the upload."
            )
        if returncode == 128 and not output.strip():
            return GitPublishError(
                "Git could not confirm access to the configured GitHub destination."
            )
        return GitPublishError(
            "Upload could not be confirmed. The verified commit is saved locally; check the network and retry."
        )


def commit_message(value: str) -> str:
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise GitPublishError("Enter a one-line commit message of at most 72 characters.")
    cleaned = " ".join(value.split())
    if not cleaned or len(cleaned) > 72:
        raise GitPublishError("Enter a one-line commit message of at most 72 characters.")
    return cleaned
