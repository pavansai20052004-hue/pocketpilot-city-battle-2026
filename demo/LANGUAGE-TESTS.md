# Mobile language acceptance checks

These are deliberately broken, newly written test projects. Do not describe a
language as phone-verified until its real analysis, proposal, approval, test, and
undo flow has completed on the installed APK.

Select one project folder on the desktop dashboard before starting its mobile
session. Undo the previous fix before switching folders.

| Language | Folder under `demo/` | Expected source | Test runner |
| --- | --- | --- | --- |
| Python | `discount-case` | `pricing.py:2` | pytest |
| Java | `java-case` | `src/main/java/demo/PriceService.java:5` | Maven / JUnit |
| JavaScript | `javascript-case` | `user.js:2` | Node test runner |
| TypeScript | `typescript-case` | `profile.ts:4` | Node 24 native type stripping + test runner |
| C# | `csharp-case` | `PriceService.cs:6` | .NET 8 / xUnit |

For each project:

1. Run its tests to display the genuine failing output. Capture the terminal,
   not a chat message or dashboard; review OCR before analysis.
2. Confirm that the mobile result names the expected source file and line.
3. Generate a fix. Review the actual diff, then approve and verify.
4. Require two tests passing, not merely successful command execution.
5. Undo and check that the original failure returns.

`tools/check_language_readiness.py` checks actual fail/pass/restored behavior and
source matching in temporary copies. It uses explicit known fixes, not Ollama,
and is not a substitute for the phone acceptance check. The original demos stay
broken. Run it with the agent virtualenv; `--language` selects one language.

The C# SDK was installed locally under the user's `Tools\dotnet` directory.
`tools/start-agent.ps1` puts that SDK on the agent's PATH. Plain `dotnet` in an
older terminal may still find the runtime-only system installation.

These fixtures establish bounded support for the listed project/test layouts;
they do not prove arbitrary codebases, every framework, JSX/TSX rendering, or
all Gradle variants. TypeScript's fixture tests runtime behavior, not typechecking.
