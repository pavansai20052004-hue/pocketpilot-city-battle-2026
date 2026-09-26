"""Canonical, bounded repository access and deterministic test selection."""

import hashlib
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .models import Location, Validation

SOURCE_EXTENSIONS = {".py", ".java", ".ts", ".tsx", ".js", ".jsx"}
SKIP_PARTS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "node_modules",
    "dist",
    "build",
    "target",
    "coverage",
    "__pycache__",
    ".next",
    ".expo",
    ".gradle",
    ".idea",
    ".vscode",
}
MAX_SOURCE_BYTES = 80_000
MAX_FILES = 600
MAX_DEPTH = 12
STACK_PATH = re.compile(r"([A-Za-z0-9_./\\-]+\.(?:py|java|ts|tsx|js|jsx))(?::(\d+))?")
SENSITIVE_LINE = re.compile(r"(?i)(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]")


def is_test_source(path: str) -> bool:
    parts = path.lower().split("/")
    name = parts[-1]
    return (
        any(part in {"test", "tests", "__tests__"} for part in parts[:-1])
        or name.startswith("test_")
        or name.endswith(
            ("_test.py", ".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx", "test.java")
        )
    )


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class SourceMatch:
    path: str
    line: int
    text: str
    sha256: str


class Workspace:
    def __init__(self, path: str):
        root = Path(path).expanduser().resolve(strict=True)
        if not root.is_dir():
            raise ValueError("Workspace must be an existing folder")
        if root == Path(root.anchor) or root == Path.home().resolve():
            raise ValueError("Choose a project folder, not a drive or home folder")
        self.root = root
        self.files = self._scan()
        if not self.files:
            raise ValueError("No supported source files found in this folder")

    def _scan(self) -> dict[str, Path]:
        found: dict[str, Path] = {}
        for base, dirs, files in os.walk(self.root, followlinks=False):
            base_path = Path(base)
            depth = len(base_path.relative_to(self.root).parts)
            if depth >= MAX_DEPTH:
                dirs[:] = []
            dirs[:] = [
                name
                for name in dirs
                if name not in SKIP_PARTS
                and not name.startswith(".")
                and not (base_path / name).is_symlink()
            ]
            for name in files:
                file_path = base_path / name
                if file_path.suffix.lower() not in SOURCE_EXTENSIONS or file_path.is_symlink():
                    continue
                if any(word in name.lower() for word in ("secret", "credential", "token")):
                    continue
                if name.startswith(".") or name.lower().endswith((".min.js", ".bundle.js")):
                    continue
                try:
                    size = file_path.stat().st_size
                    resolved = file_path.resolve(strict=True)
                    rel = resolved.relative_to(self.root).as_posix()
                except (OSError, ValueError):
                    continue
                if 0 < size <= MAX_SOURCE_BYTES:
                    found[rel] = resolved
                if len(found) >= MAX_FILES:
                    return found
        return found

    def safe_file(self, relative: str) -> Path:
        normalized = relative.replace("\\", "/")
        if normalized not in self.files:
            raise ValueError("File is outside the selected source index")
        path = self.files[normalized]
        if path.is_symlink() or path.resolve(strict=True) != path:
            raise ValueError("File boundary changed")
        path.relative_to(self.root)
        if path.stat().st_size > MAX_SOURCE_BYTES:
            raise ValueError("Source file exceeds size limit")
        return path

    def locate(self, error_text: str) -> SourceMatch | None:
        candidates: list[tuple[str, int]] = []
        for match in STACK_PATH.finditer(error_text):
            raw = match.group(1).replace("\\", "/")
            basename = raw.rsplit("/", 1)[-1]
            line = int(match.group(2) or 1)
            if line < 1:
                continue
            exact = [key for key in self.files if raw.endswith(key)]
            hits = exact or [key for key in self.files if key.rsplit("/", 1)[-1] == basename]
            if len(hits) == 1 and not is_test_source(hits[0]):
                candidates.append((hits[0], line))
        if not candidates:
            return None
        # Test code provides evidence, but never becomes the patch target.
        path, line = candidates[0]
        file_path = self.safe_file(path)
        raw_bytes = file_path.read_bytes()
        try:
            source = raw_bytes.decode("utf-8")
        except UnicodeDecodeError:
            return None
        if line > len(source.splitlines()) + 1:
            return None
        return SourceMatch(path, line, source, digest(raw_bytes))

    def context(self, match: SourceMatch) -> str:
        lines = match.text.splitlines()
        # Enough context for small files; bounded around the stack frame for larger files.
        start = max(0, match.line - 50)
        end = min(len(lines), match.line + 50)
        selected = lines if len(lines) <= 180 else lines[start:end]
        numbered = []
        offset = 0 if len(lines) <= 180 else start
        for number, line in enumerate(selected, offset + 1):
            if SENSITIVE_LINE.search(line):
                line = "[sensitive line omitted]"
            numbered.append(f"{number:4}: {line}")
        return "\n".join(numbered)[:18_000]

    def test_command(self) -> tuple[list[str], str] | None:
        if (self.root / "pom.xml").is_file():
            return (["mvn", "-q", "test"], "mvn -q test")
        if (self.root / "pytest.ini").is_file() or (self.root / "pyproject.toml").is_file():
            return ([sys.executable, "-m", "pytest", "-q"], "python -m pytest -q")
        return None

    def verify(self) -> Validation:
        selected = self.test_command()
        if selected is None:
            return Validation(
                passed=False,
                command="none",
                exit_code=None,
                output="No allowlisted project test command was detected.",
            )
        argv, display = selected
        try:
            process = subprocess.run(
                argv,
                cwd=self.root,
                shell=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=120,
                check=False,
            )
            output = (process.stdout + "\n" + process.stderr)[-8000:]
            return Validation(
                passed=process.returncode == 0,
                command=display,
                exit_code=process.returncode,
                output=output,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return Validation(passed=False, command=display, exit_code=None, output=str(exc)[:1000])

    def location(self, match: SourceMatch) -> Location:
        return Location(path=match.path, line=match.line)
