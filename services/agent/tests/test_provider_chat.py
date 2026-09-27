"""Local model privacy and chat payload tests."""

import asyncio

import pytest

from pocketpilot_agent import provider


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1:11434",
        "http://192.168.1.20:11434",
        "http://ollama.example:11434",
        "http://user:pass@127.0.0.1:11434",
        "http://127.0.0.1:11434/proxy",
        "http://127.0.0.1:11434/?remote=1",
    ],
)
def test_ollama_rejects_non_loopback_or_decorated_endpoints(monkeypatch, url):
    monkeypatch.setattr(provider, "OLLAMA_URL", url)
    with pytest.raises(provider.ProviderError, match="loopback-only"):
        provider.ollama_base_url()


def test_ollama_allows_local_ipv4_ipv6_and_localhost(monkeypatch):
    for url in ("http://127.0.0.1:11434", "http://[::1]:11434", "http://localhost:11434"):
        monkeypatch.setattr(provider, "OLLAMA_URL", url)
        assert provider.ollama_base_url() == url


def test_common_credentials_are_redacted():
    raw = (
        "Authorization: Bearer abc.def_123 password='supersecret' "
        "api_key=sk-live-private OPENAI_API_KEY=private-openai-key "
        "GITHUB_TOKEN=private-github-token AKIAABCDEFGHIJKLMNOP "
        "jwt=eyJabcdefghijk.abcdefghijklmnop.qrstuvwxyz012345 "
        "https://person:pass@example.test/path "
        "-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----"
    )
    cleaned = provider.redact_sensitive_text(raw)
    for secret in (
        "abc.def_123",
        "supersecret",
        "sk-live-private",
        "private-openai-key",
        "private-github-token",
        "AKIAABCDEFGHIJKLMNOP",
        "person:pass",
        "private",
    ):
        assert secret not in cleaned
    assert "[REDACTED_JWT]" in cleaned


def test_chat_redacts_all_user_context_and_model_output(monkeypatch):
    monkeypatch.setattr(provider, "OLLAMA_URL", "http://127.0.0.1:11434")
    observed = {}

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"message": {"content": "Avoid repeating Bearer output.secret"}}

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, json):
            observed["url"] = url
            observed["payload"] = json
            return Response()

    monkeypatch.setattr(provider.httpx, "AsyncClient", lambda **_kwargs: Client())
    result = asyncio.run(
        provider.OllamaProvider().chat(
            message="Please review api_key=private-key",
            history=[{"role": "user", "content": "Bearer old-secret"}],
            context="Reported failure contains password=hunter2",
        )
    )
    assert observed["url"] == "http://127.0.0.1:11434/api/chat"
    text = "\n".join(item["content"] for item in observed["payload"]["messages"])
    for secret in ("private-key", "old-secret", "hunter2", "output.secret"):
        assert secret not in text
    assert "Reference facts" in text
    assert "cannot run commands" in text
    assert "Bearer [REDACTED]" in result


def test_chat_fails_closed_before_network_for_remote_ollama(monkeypatch):
    monkeypatch.setattr(provider, "OLLAMA_URL", "http://ollama.example:11434")

    class MustNotConnect:
        def __init__(self, **_kwargs):
            pytest.fail("remote Ollama must be rejected before opening a client")

    monkeypatch.setattr(provider.httpx, "AsyncClient", MustNotConnect)
    with pytest.raises(provider.ProviderError, match="loopback-only"):
        asyncio.run(provider.OllamaProvider().chat(message="question", history=[], context=""))
