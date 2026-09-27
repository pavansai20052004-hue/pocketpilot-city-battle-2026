# Product roadmap

This is a set of proposed directions from the product brief, not a delivery commitment. The current implementation and release scope are described in the [README](../README.md) and [changelog](../CHANGELOG.md).

## Not implemented in 1.1.0

- **Managed sign-in:** Google sign-in, OAuth providers, accounts, and account-level access controls. Current pairing uses a temporary local code and in-memory token.
- **Remote repository onboarding:** browsing, cloning, or granting direct GitHub repository access. Current workflows operate on a project folder already present on the laptop and can optionally publish one verified file through its configured Git remote.
- **Explainable evaluation:** a separately designed multi-signal or “Matrix Analysis” layer, calibrated evidence score, and formal logical-consistency checks. Current analysis presents model reasoning and selected repository evidence; the high/low label describes whether the workspace matcher found a source location, not diagnosis correctness. Deterministic patch validation and real checks gate changes.

Any work in these areas needs explicit data-flow, permission, failure, and acceptance criteria before being presented as shipped functionality.
