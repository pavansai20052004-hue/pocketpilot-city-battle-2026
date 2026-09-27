# Contributing

Thanks for helping improve PocketPilot. Keep changes small, preserve the approval and privacy boundaries, and describe behavior that is implemented separately from work that is planned.

## Development setup

Use Node.js 24 or newer, npm 11 or newer, and Python 3.11 or newer. Install the frontend and agent dependencies using the instructions in the [README](README.md#run-locally).

## Before opening a pull request

Run the relevant checks from the repository root or `services/agent`:

```powershell
npm ci
npm run check
cd services/agent
python -m pip install -e ".[dev]"
python -m pytest -q
python -m ruff check src tests
python -m ruff format --check src tests
```

For changes to the Android UI or native modules, include the device/emulator and Android build checks you completed. A successful TypeScript build alone does not verify a native Android flow.

## Pull request notes

- Explain the user-visible behavior and any limitations.
- Include the checks you ran and their results.
- Add before/after screenshots for meaningful UI changes.
- Call out changes to model providers, network egress, credentials, filesystem scope, command execution, or Git publishing.
- Never commit API keys, tokens, credentials, user logs, or real project source from outside this repository.
- Update the changelog when a change affects the upcoming app release.
