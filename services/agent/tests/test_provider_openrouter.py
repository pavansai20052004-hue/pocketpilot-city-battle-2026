"""OpenRouter transport must be bounded, redacted, and key-safe."""

import asyncio
import json

import httpx
import pytest

from pocketpilot_agent import provider


class MockResponse:
    def __init__(self, payload, status=200):
        self.payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions")
            response = httpx.Response(self.status_code, request=request, text="private-provider-error")
            raise httpx.HTTPStatusError("private-provider-error", request=request, response=response)

    def json(self):
        return self.payload


def install_mock_client(monkeypatch, observed, content):
    class MockClient:
        def __init__(self, **kwargs):
            observed["client_options"] = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, headers, json):
            observed["calls"] = observed.get("calls", 0) + 1
            observed["url"] = url
            observed["headers"] = headers
            observed["payload"] = json
            return MockResponse({"choices": [{"message": {"content": content}}]})

    monkeypatch.setattr(provider.httpx, "AsyncClient", MockClient)


def test_openrouter_analysis_redacts_error_and_source_and_uses_fixed_https(monkeypatch):
    observed = {}
    answer = json.dumps(
        {
            "title": "Handle missing discount",
            "problem": "None reaches the calculation",
            "evidence": "The matched line multiplies the optional value",
            "repair_strategy": "Return the original amount when absent",
        }
    )
    install_mock_client(monkeypatch, observed, answer)
    client = provider.OpenRouterProvider("secret-test-key", "recommended/model")

    result = asyncio.run(
        client.analyze(
            error_text="TypeError api_key=error-secret",
            path="src/pricing.py",
            source="def price(): return amount * percent  # password=source-secret",
        )
    )

    assert result["title"] == "Handle missing discount"
    assert observed["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert observed["headers"]["Authorization"] == "Bearer secret-test-key"
    assert observed["client_options"]["follow_redirects"] is False
    sent = json.dumps(observed["payload"])
    assert "error-secret" not in sent
    assert "source-secret" not in sent
    assert "secret-test-key" not in sent
    assert observed["payload"]["response_format"] == {"type": "json_object"}
    assert observed["payload"]["max_tokens"] == 900


def test_openrouter_proposal_redacts_full_matched_source(monkeypatch):
    observed = {}
    answer = json.dumps(
        {
            "title": "Handle missing value",
            "summary": "Return the original price",
            "why": "The value may be null",
            "expected_effect": "The exception is avoided",
            "old_text": "return total * rate",
            "new_text": "return total if rate is None else total * rate",
        }
    )
    install_mock_client(monkeypatch, observed, answer)
    client = provider.OpenRouterProvider("secret-test-key", "recommended/model")

    result = asyncio.run(
        client.propose(
            path="src/pricing.py",
            source="def price():\n    api_key = 'source-secret'\n    return total * rate",
            error_text="TypeError password=error-secret",
            analysis='{"problem":"token=analysis-secret"}',
        )
    )

    assert result["old_text"] == "return total * rate"
    sent = json.dumps(observed["payload"])
    for secret in ("source-secret", "error-secret", "analysis-secret", "secret-test-key"):
        assert secret not in sent
    assert observed["payload"]["max_tokens"] == 1700


def test_openrouter_chat_redacts_messages_and_does_not_retry(monkeypatch):
    observed = {}
    install_mock_client(monkeypatch, observed, "Avoid repeating Bearer output-secret")
    client = provider.OpenRouterProvider("secret-test-key", "recommended/model")

    result = asyncio.run(
        client.chat(
            message="Explain api_key=user-secret",
            history=[{"role": "user", "content": "Bearer history-secret"}],
            context="The test output contains password=context-secret",
        )
    )

    sent = json.dumps(observed["payload"])
    for secret in ("user-secret", "history-secret", "context-secret", "secret-test-key"):
        assert secret not in sent
    assert "output-secret" not in result
    assert observed["calls"] == 1


def test_openrouter_requires_key_and_valid_model_before_network():
    with pytest.raises(provider.ProviderError):
        provider.OpenRouterProvider("", "recommended/model")
    with pytest.raises(provider.ProviderError):
        provider.OpenRouterProvider("secret-test-key", "https://attacker.example")


def test_openrouter_rejects_malformed_structured_response():
    with pytest.raises(provider.ProviderError, match="incomplete structured"):
        provider.validate_json_response('{"title":"only one field"}', ("title", "problem"))


def test_openrouter_key_health_is_cached_and_never_exposes_key(monkeypatch):
    observed = {}

    class MockClient:
        def __init__(self, **kwargs):
            observed["client_options"] = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url, *, headers):
            observed["calls"] = observed.get("calls", 0) + 1
            observed["url"] = url
            observed["headers"] = headers
            return MockResponse({"data": {"limit_remaining": 5}})

    monkeypatch.setattr(provider.httpx, "AsyncClient", MockClient)
    client = provider.OpenRouterProvider("secret-test-key", "recommended/model")
    assert asyncio.run(client.ready()) is True
    assert asyncio.run(client.ready()) is True
    assert observed["calls"] == 1
    assert observed["url"] == "https://openrouter.ai/api/v1/key"
    assert observed["headers"]["Authorization"] == "Bearer secret-test-key"
