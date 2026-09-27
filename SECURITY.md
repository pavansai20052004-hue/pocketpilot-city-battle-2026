# Security policy

## Supported version

The current source candidate is 1.1.0. It is not a published or store-signed release.

## Report a vulnerability

Please do not publish credentials, exploit details, or an unpatched vulnerability in a public issue. If GitHub's **Report a vulnerability** option is available under this repository's **Security** tab, use the private advisory form. Otherwise, contact the repository owner through a private contact method on their GitHub profile and include a safe reproduction and affected commit or version.

Do not attach real project code, error logs, tokens, or other secrets. Redact sensitive values from reproduction steps.

## Security boundaries

PocketPilot is a local development tool and should only be paired over a trusted private network. The phone-to-laptop API uses local HTTP. Model output is untrusted; changes require explicit approval, validation, an allowlisted project check, and hash-guarded recovery. OpenRouter is opt-in and sends bounded session/source context outside the laptop. Secret redaction is best effort and is not a guarantee.

See the [agent documentation](services/agent/README.md) for the current implementation's specific limits.
