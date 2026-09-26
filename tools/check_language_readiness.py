"""Run actual failing/passing/restored test suites in temporary project copies.

Does not call AI, approve phone sessions, or change the live demo source.
Run with the agent virtualenv Python from the repository root.
"""

import argparse
import json
import shutil
import tempfile
from pathlib import Path

from pocketpilot_agent.workspace import Workspace

ROOT = Path(__file__).resolve().parents[1]
CASES = [
    (
        "Python",
        "discount-case",
        "pricing.py",
        "    return amount -",
        "    if percent is None:\n        return amount\n    return amount -",
    ),
    (
        "Java",
        "java-case",
        "src/main/java/demo/PriceService.java",
        "        return amount -",
        "        if (percent == null) return amount;\n        return amount -",
    ),
    (
        "JavaScript",
        "javascript-case",
        "user.js",
        "  return user.name;",
        "  if (user == null) return 'Guest';\n  return user.name;",
    ),
    (
        "TypeScript",
        "typescript-case",
        "profile.ts",
        "  return user!.name;",
        "  if (user == null) return 'Guest';\n  return user.name;",
    ),
    (
        "C#",
        "csharp-case",
        "PriceService.cs",
        "        return amount -",
        "        if (percent is null) return amount;\n        return amount -",
    ),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--language", choices=[case[0] for case in CASES])
    args = parser.parse_args()
    results = []
    with tempfile.TemporaryDirectory(prefix="pocketpilot-language-check-") as scratch:
        for language, folder, source, old, new in CASES:
            if args.language and language != args.language:
                continue
            project = Path(scratch) / folder
            shutil.copytree(
                ROOT / "demo" / folder,
                project,
                ignore=shutil.ignore_patterns(
                    "target", "bin", "obj", "__pycache__", ".pytest_cache"
                ),
            )
            workspace = Workspace(str(project))
            before = workspace.verify(source)
            match = workspace.locate(before.output)
            file = project / source
            original = file.read_bytes()
            assert old in original.decode(), (
                f"{language}: demo is no longer the expected broken state"
            )
            file.write_text(original.decode().replace(old, new, 1), encoding="utf-8")
            after = workspace.verify(source)
            file.write_bytes(original)
            restored = workspace.verify(source)
            passed = (
                before.exit_code not in (None, 0)
                and match is not None
                and match.path == source
                and after.passed
                and restored.exit_code not in (None, 0)
            )
            result = {
                "language": language,
                "passed": passed,
                "command": before.command,
                "location": match.path if match else None,
                "line": match.line if match else None,
                "broken_exit": before.exit_code,
                "fixed_exit": after.exit_code,
                "restored_exit": restored.exit_code,
                "original_error": before.output,
                "fixed_output": after.output,
            }
            results.append(result)
            print(json.dumps(result), flush=True)
    return 0 if all(item["passed"] for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
