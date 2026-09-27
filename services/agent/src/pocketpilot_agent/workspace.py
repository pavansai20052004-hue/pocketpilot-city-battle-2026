"""Canonical, bounded repository access and deterministic test selection."""

import ctypes
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .models import ContextSource, Location, Validation

SOURCE_EXTENSIONS = {".py", ".java", ".ts", ".tsx", ".js", ".jsx", ".cs"}
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
MAX_SOURCE_BYTES = 256_000
MAX_FILES = 600
MAX_DEPTH = 12
CONTEXT_CHUNK_LINES = 72
CONTEXT_CHUNK_OVERLAP = 12
MAX_CONTEXT_CHUNKS = 4
MAX_CONTEXT_CHARS = 18_000
MAX_RELATED_FILES_SCANNED = 24
MAX_RELATED_SCAN_BYTES = 2_000_000
# OCR can insert spaces around an extension dot ("pricing. py:2") or read it
# as a dash ("pricing-py:2"). An explicit line and unique indexed source are
# still required before the location can be trusted.
STACK_PATH = re.compile(
    r"(?<![A-Za-z0-9_./\\-])((?:[A-Za-z]:[\\/])?[A-Za-z0-9_./\\ -]+?)[ \t]*"
    r"[.\-][ \t]*(py|java|ts|tsx|js|jsx|cs)[ \t]*:[ \t]*(\d+)\b",
    re.IGNORECASE,
)
# JavaScript/TypeScript and .NET compilers commonly report file(line,column).
PARENTHESIZED_LOCATION = re.compile(
    r"(?<![A-Za-z0-9_./\\-])((?:[A-Za-z]:[\\/])?[A-Za-z0-9_./\\ -]+?)[ \t]*"
    r"[.\-][ \t]*(py|java|ts|tsx|js|jsx|cs)[ \t]*\([ \t]*(\d+)"
    r"(?:[ \t]*,[ \t]*\d+)?[ \t]*\)",
    re.IGNORECASE,
)
# .NET stack frames use `in path/File.cs:line 42`, unlike Java/Python frames.
CSHARP_FRAME = re.compile(
    r"\bin\s+((?:[A-Za-z]:[\\/])?[^\r\n()]+?\.[ \t]*cs):[ \t]*line[ \t]+(\d+)\b",
    re.IGNORECASE,
)
# Python tracebacks put the line marker after the quoted filename. Camera OCR
# may also confuse the `i` in "line" with an accented character.
TRACEBACK_FRAME = re.compile(
    r"\bFile\s+['\"]([^'\"]+?\.[ \t]*(?:py|java|ts|tsx|js|jsx|cs))['\"]"
    r"[^\r\n]{0,48}?\bl[ií]ne\s+(\d+)\b",
    re.IGNORECASE,
)
SENSITIVE_LINE = re.compile(r"(?i)(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]")
IDENTIFIER = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
CAMEL_PART = re.compile(r"[A-Z]?[a-z]+|[A-Z]+(?=[A-Z]|$)|\d+")
CONTEXT_STOPWORDS = {
    "this",
    "that",
    "with",
    "from",
    "when",
    "then",
    "they",
    "have",
    "has",
    "will",
    "into",
    "true",
    "false",
    "null",
    "none",
    "line",
    "test",
    "tests",
    "error",
    "exception",
    "failure",
    "failed",
    "expected",
    "actual",
    "java",
    "python",
    "typescript",
    "javascript",
    "service",
    "class",
    "return",
    "public",
    "private",
    "static",
    "void",
    "string",
    "int",
}


def _identifier_terms(value: str) -> set[str]:
    terms: set[str] = set()
    for identifier in IDENTIFIER.findall(value):
        parts = CAMEL_PART.findall(identifier)
        for term in (*parts, identifier):
            folded = term.casefold()
            if len(folded) >= 4 and folded not in CONTEXT_STOPWORDS:
                terms.add(folded)
    return terms


def _fixed_command_argv(command: str, *arguments: str) -> list[str]:
    """Build a fixed argv, using cmd.exe only for Windows batch entry points."""
    if os.name == "nt" and Path(command).suffix.lower() in {".bat", ".cmd"}:
        command_path = Path(command)
        if command_path.name.lower() in {"npm.cmd", "npm.bat"}:
            node = shutil.which("node")
            npm_cli = command_path.parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
            if node and npm_cli.is_file() and not npm_cli.is_symlink():
                # Run npm's fixed CLI through node.exe directly. Passing a quoted
                # .cmd path through cmd.exe breaks on spaces in Program Files.
                return [node, str(npm_cli), *arguments]

        executable = command
        if " " in executable:
            # cmd.exe does not follow the usual Windows argv quoting rules. Use
            # the filesystem's short path so the /c payload needs no quotes.
            required = ctypes.windll.kernel32.GetShortPathNameW(executable, None, 0)
            if required:
                buffer = ctypes.create_unicode_buffer(required + 1)
                if ctypes.windll.kernel32.GetShortPathNameW(executable, buffer, len(buffer)):
                    executable = buffer.value
        if " " in executable:
            raise OSError("The Windows test launcher path cannot be started safely.")
        command_line = subprocess.list2cmdline([executable, *arguments])
        return [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", command_line]
    return [command, *arguments]


def is_test_source(path: str) -> bool:
    parts = path.lower().split("/")
    name = parts[-1]
    return (
        any(part in {"test", "tests", "__tests__"} for part in parts[:-1])
        or name.startswith("test_")
        or name.endswith(
            (
                "_test.py",
                ".test.ts",
                ".test.tsx",
                ".test.js",
                ".test.jsx",
                ".spec.ts",
                ".spec.tsx",
                ".spec.js",
                ".spec.jsx",
                "test.java",
                "tests.java",
                "test.cs",
                "tests.cs",
            )
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

    def locate(self, error_text: str, *, include_tests: bool = False) -> SourceMatch | None:
        candidates: list[tuple[str, int]] = []

        def add_candidate(raw_path: str, line_text: str) -> None:
            # OCR may add spaces just before a path separator or extension dot.
            # Trim path components, then trust only a unique indexed-file match.
            raw = "/".join(part.strip() for part in raw_path.replace("\\", "/").split("/"))
            raw = re.sub(
                r"[ \t]*\.[ \t]*(py|java|ts|tsx|js|jsx|cs)$",
                lambda match: "." + match.group(1).lower(),
                raw,
                flags=re.IGNORECASE,
            )
            basename = raw.rsplit("/", 1)[-1]
            line = int(line_text)
            if line < 1:
                return
            folded_raw = raw.casefold()
            exact = [
                key
                for key in self.files
                if folded_raw == key.casefold() or folded_raw.endswith("/" + key.casefold())
            ]
            hits = exact or [
                key
                for key in self.files
                if key.rsplit("/", 1)[-1].casefold() == basename.casefold()
            ]
            if len(hits) == 1 and is_test_source(hits[0]) == include_tests:
                candidates.append((hits[0], line))

        for match in STACK_PATH.finditer(error_text):
            add_candidate(
                f"{match.group(1)}.{match.group(2)}",
                match.group(3),
            )
        for match in PARENTHESIZED_LOCATION.finditer(error_text):
            add_candidate(f"{match.group(1)}.{match.group(2)}", match.group(3))
        for match in CSHARP_FRAME.finditer(error_text):
            add_candidate(match.group(1), match.group(2))
        for match in TRACEBACK_FRAME.finditer(error_text):
            add_candidate(match.group(1), match.group(2))

        # Test frames are useful evidence, but never become patch targets.
        # Skip invalid line numbers and try the next grounded source frame.
        for path, line in candidates:
            file_path = self.safe_file(path)
            raw_bytes = file_path.read_bytes()
            try:
                source = raw_bytes.decode("utf-8")
            except UnicodeDecodeError:
                continue
            if line <= len(source.splitlines()):
                return SourceMatch(path, line, source, digest(raw_bytes))
        return None

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

    def _bounded_chunk(
        self,
        match: SourceMatch,
        *,
        role: Literal["target", "test", "related"],
        max_lines: int,
        max_chars: int,
    ) -> tuple[ContextSource, str]:
        lines = match.text.splitlines()
        anchor = match.line - 1
        if len(lines) <= max_lines:
            start, end = 0, len(lines)
        else:
            start = max(0, min(anchor - max_lines // 2, len(lines) - max_lines))
            end = min(len(lines), start + max_lines)

        def render(first: int, last: int) -> str:
            selected = [
                "[sensitive line omitted]" if SENSITIVE_LINE.search(line) else line
                for line in lines[first:last]
            ]
            return "\n".join(selected)

        text = render(start, end)
        while len(text) > max_chars and start < anchor and end > anchor + 1:
            if anchor - start >= end - 1 - anchor:
                start += 1
            else:
                end -= 1
            text = render(start, end)
        if len(text) > max_chars:
            text = text[:max_chars]
        return (
            ContextSource(
                role=role,
                path=match.path,
                start_line=start + 1,
                end_line=max(start + 1, end),
            ),
            text,
        )

    def target_chunk(self, match: SourceMatch) -> tuple[ContextSource, str]:
        """Return bounded edit context and its absolute line range."""
        return self._bounded_chunk(match, role="target", max_lines=120, max_chars=16_000)

    def analysis_context(
        self, match: SourceMatch, error_text: str
    ) -> tuple[str, list[ContextSource]]:
        """Build a local, deterministic evidence pack; only the target can be patched."""
        selected: list[tuple[ContextSource, str]] = []

        def render_block(source: ContextSource, text: str) -> str:
            return (
                f"[{source.role.upper()} CHUNK "
                f"{source.path}:{source.start_line}-{source.end_line}]\n{text}"
            )

        def selected_size() -> int:
            return (
                sum(len(render_block(source, text)) for source, text in selected)
                + max(0, len(selected) - 1) * 2
            )

        target_ref, target_text = self._bounded_chunk(
            match, role="target", max_lines=72, max_chars=8_000
        )
        selected.append((target_ref, target_text))
        used_paths = {match.path}

        test_match = self.locate(error_text, include_tests=True)
        if test_match and test_match.path not in used_paths and len(selected) < MAX_CONTEXT_CHUNKS:
            test_ref, test_text = self._bounded_chunk(
                test_match, role="test", max_lines=48, max_chars=4_000
            )
            selected.append((test_ref, test_text))
            if selected_size() <= MAX_CONTEXT_CHARS:
                used_paths.add(test_match.path)
            else:
                selected.pop()

        query_terms = _identifier_terms(error_text[:8_000] + "\n" + target_text)
        target_parts = match.path.split("/")
        candidates: list[tuple[int, str, ContextSource, str]] = []
        related_files_scanned = 0
        related_bytes_scanned = 0
        for path in sorted(self.files):
            if path in used_paths or is_test_source(path):
                continue
            path_terms = _identifier_terms(Path(path).stem)
            path_overlap = query_terms & path_terms
            if not path_overlap:
                continue
            path_parts = path.split("/")
            common_depth = 0
            for left, right in zip(target_parts[:-1], path_parts[:-1]):
                if left.casefold() != right.casefold():
                    break
                common_depth += 1
            if common_depth < 2 and len(path_overlap) < 2:
                continue
            if related_files_scanned >= MAX_RELATED_FILES_SCANNED:
                break

            try:
                candidate_path = self.safe_file(path)
                candidate_size = candidate_path.stat().st_size
                if related_bytes_scanned + candidate_size > MAX_RELATED_SCAN_BYTES:
                    continue
                candidate_text = candidate_path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError, ValueError):
                continue
            related_files_scanned += 1
            related_bytes_scanned += candidate_size
            candidate_lines = candidate_text.splitlines()
            step = max(1, CONTEXT_CHUNK_LINES - CONTEXT_CHUNK_OVERLAP)
            best: tuple[int, int, int] | None = None
            for start in range(0, len(candidate_lines), step):
                end = min(len(candidate_lines), start + CONTEXT_CHUNK_LINES)
                chunk = "\n".join(candidate_lines[start:end])
                overlap = query_terms & _identifier_terms(chunk)
                score = len(overlap) + 2 * len(path_overlap)
                if len(overlap) < 2 or score < 4:
                    continue
                if best is None or score > best[0]:
                    best = (score, start, end)
                if end == len(candidate_lines):
                    break
            if best is None:
                continue
            score, start, end = best
            candidate_match = SourceMatch(
                path=path,
                line=(start + end) // 2 + 1,
                text=candidate_text,
                sha256=digest(candidate_text.encode("utf-8")),
            )
            ref, bounded_text = self._bounded_chunk(
                candidate_match,
                role="related",
                max_lines=CONTEXT_CHUNK_LINES,
                max_chars=3_000,
            )
            candidates.append((score, path, ref, bounded_text))

        candidates.sort(key=lambda item: (-item[0], item[1], item[2].start_line))
        for _, path, ref, text in candidates:
            if len(selected) >= MAX_CONTEXT_CHUNKS:
                break
            selected.append((ref, text))
            if selected_size() > MAX_CONTEXT_CHARS:
                selected.pop()
                continue
            used_paths.add(path)

        blocks = [render_block(source, text) for source, text in selected]
        context = "\n\n".join(blocks)
        assert len(context) <= MAX_CONTEXT_CHARS
        return context, [source for source, _ in selected]

    def test_command(self, source_path: str | None = None) -> tuple[list[str], str, Path] | None:
        # Select the nearest project manifest above the approved source file.
        # This lets a monorepo run the relevant test suite, not an unrelated root.
        relative = Path(source_path) if source_path else Path(".")
        if source_path and source_path not in self.files:
            raise ValueError("Verification target is outside the source index")
        directory = (self.root / relative).parent if source_path else self.root
        while directory == self.root or self.root in directory.parents:
            if (directory / "pom.xml").is_file() and not (directory / "pom.xml").is_symlink():
                return (
                    _fixed_command_argv(shutil.which("mvn") or "mvn", "-q", "test"),
                    "mvn -q test",
                    directory,
                )
            gradle_files = (
                "build.gradle",
                "build.gradle.kts",
                "settings.gradle",
                "settings.gradle.kts",
            )
            if any(
                (directory / name).is_file() and not (directory / name).is_symlink()
                for name in gradle_files
            ):
                arguments = ("--no-daemon", "--console=plain", "test")
                windows_wrapper = directory / "gradlew.bat"
                unix_wrapper = directory / "gradlew"
                if (
                    os.name == "nt"
                    and windows_wrapper.is_file()
                    and not windows_wrapper.is_symlink()
                ):
                    return (
                        _fixed_command_argv(windows_wrapper.name, *arguments),
                        "gradlew.bat --no-daemon --console=plain test",
                        directory,
                    )
                if os.name != "nt" and unix_wrapper.is_file() and os.access(unix_wrapper, os.X_OK):
                    return (
                        [str(unix_wrapper), *arguments],
                        "./gradlew --no-daemon --console=plain test",
                        directory,
                    )
                gradle = shutil.which("gradle")
                if gradle:
                    return (
                        _fixed_command_argv(gradle, *arguments),
                        "gradle --no-daemon --console=plain test",
                        directory,
                    )
                return None
            dotnet_projects = [
                path
                for pattern in ("*.sln", "*.slnx", "*.csproj")
                for path in directory.glob(pattern)
                if path.is_file() and not path.is_symlink()
            ]
            if dotnet_projects:
                # Prefer a solution when present; otherwise only run a unique project.
                solutions = [
                    path for path in dotnet_projects if path.suffix.lower() in {".sln", ".slnx"}
                ]
                candidates = solutions or [
                    path for path in dotnet_projects if path.suffix.lower() == ".csproj"
                ]
                dotnet = shutil.which("dotnet")
                if dotnet and len(candidates) == 1:
                    target = candidates[0]
                    return (
                        [dotnet, "test", str(target), "--nologo", "--verbosity", "quiet"],
                        f"dotnet test {target.name}",
                        directory,
                    )
                return None
            if any(
                (directory / name).is_file() and not (directory / name).is_symlink()
                for name in ("pytest.ini", "pyproject.toml")
            ):
                return [sys.executable, "-m", "pytest", "-q"], "python -m pytest -q", directory
            package = directory / "package.json"
            if package.is_file() and not package.is_symlink():
                try:
                    payload = json.loads(package.read_text(encoding="utf-8"))
                    scripts = payload.get("scripts", {})
                    script = scripts.get("test", "")
                except (OSError, ValueError, AttributeError):
                    scripts = {}
                    script = ""
                if isinstance(script, str) and script.strip():
                    command = script.strip().lower()
                    recognized = command in {
                        "vitest",
                        "vitest run",
                        "jest",
                        "jest --runinband",
                        "react-scripts test",
                        "node --test",
                    }
                    if recognized and not (scripts.get("pretest") or scripts.get("posttest")):
                        extra = ["--", "--run"] if command == "vitest" else []
                        display = "npm run test" + (" -- --run" if extra else "")
                        return (
                            _fixed_command_argv(
                                shutil.which("npm") or "npm", "run", "test", *extra
                            ),
                            display,
                            directory,
                        )
                # An unsupported test script is not verification; do not fall
                # back to a parent package that may test an unrelated project.
                return None
            if directory == self.root:
                break
            directory = directory.parent
        return None

    def verify(self, source_path: str | None = None) -> Validation:
        selected = self.test_command(source_path)
        if selected is None:
            return Validation(
                passed=False,
                command="none",
                exit_code=None,
                output="No allowlisted project test command was detected.",
            )
        argv, display, directory = selected
        try:
            process = subprocess.run(
                argv,
                cwd=directory,
                env={**os.environ, "CI": "true"},
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
