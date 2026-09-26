"""Focused contract and safety tests for the fresh event backend."""

import asyncio
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pocketpilot_agent import main as agent
from pocketpilot_agent.models import Proposal, ProposedFile, Session
from pocketpilot_agent.workspace import Workspace, digest


def project(tmp_path: Path) -> Path:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='tiny'\nversion='0.1'\n")
    (tmp_path / "user_service.py").write_text(
        'def get_name(user):\n    return user["name"]\n', encoding="utf-8"
    )
    (tmp_path / "test_user_service.py").write_text(
        "from user_service import get_name\n\n"
        "def test_missing_user():\n    assert get_name(None) == 'Unknown'\n",
        encoding="utf-8",
    )
    return tmp_path


async def wait_stage(client: TestClient, token: str, target: str) -> dict:
    for _ in range(30):
        response = client.get("/api/state", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 200
        session = response.json()["session"]
        if session and session["stage"] == target:
            return session
        await asyncio.sleep(0.05)
    pytest.fail(f"Timed out waiting for {target}")


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("POCKETPILOT_RECOVERY_PATH", str(tmp_path / "recovery.json"))
    monkeypatch.setattr(agent, "state", agent.AgentState())

    async def ready():
        return True

    async def analyze(**kwargs):
        return {
            "title": "Missing user is dereferenced",
            "problem": "The function indexes None.",
            "evidence": "The reported frame points to the indexed expression.",
            "repair_strategy": "Return a fallback before indexing.",
        }

    async def propose(**kwargs):
        return {
            "title": "Handle a missing user",
            "summary": "Return the fallback for None.",
            "why": "The existing expression indexes None.",
            "expected_effect": "The missing-user test should pass.",
            "old_text": '    return user["name"]',
            "new_text": '    if user is None:\n        return "Unknown"\n    return user["name"]',
        }

    monkeypatch.setattr(agent.state.provider, "ready", ready)
    monkeypatch.setattr(agent.state.provider, "analyze", analyze)
    monkeypatch.setattr(agent.state.provider, "propose", propose)
    with TestClient(agent.app) as test_client:
        yield test_client


def pair(client: TestClient) -> str:
    code = client.post("/api/pairing-code").json()["code"]
    response = client.post("/api/pair", json={"code": code, "device_name": "test phone"})
    assert response.status_code == 200
    return response.json()["token"]


def test_approval_verification_recovery_undo(tmp_path, client, monkeypatch):
    folder = project(tmp_path)
    original = (folder / "user_service.py").read_bytes()
    assert client.post("/api/workspace", json={"path": str(folder)}).status_code == 200
    token = pair(client)
    headers = {"Authorization": f"Bearer {token}"}

    created = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "error_text": "user_service.py:2: TypeError: NoneType is not subscriptable",
            "source": "text",
        },
    )
    assert created.status_code == 202
    session_id = created.json()["id"]
    analyzed = asyncio.run(wait_stage(client, token, "root_cause_found"))
    assert analyzed["analysis"]["confidence"] == "high"
    assert analyzed["analysis"]["location"] == {"path": "user_service.py", "line": 2}

    generating = client.post(f"/api/sessions/{session_id}/proposal", headers=headers)
    assert generating.status_code == 202
    proposed = asyncio.run(wait_stage(client, token, "awaiting_approval"))
    assert (folder / "user_service.py").read_bytes() == original

    wrong = client.post(
        f"/api/sessions/{session_id}/approve",
        headers=headers,
        json={"proposal_id": proposed["proposal"]["id"], "revision": proposed["revision"] - 1},
    )
    assert wrong.status_code == 409
    approved = client.post(
        f"/api/sessions/{session_id}/approve",
        headers=headers,
        json={"proposal_id": proposed["proposal"]["id"], "revision": proposed["revision"]},
    )
    assert approved.status_code == 200
    assert approved.json()["stage"] == "verified"
    assert approved.json()["validation"]["passed"] is True
    assert (folder / "user_service.py").read_bytes() != original
    monkeypatch.setattr(agent, "state", agent.AgentState())
    assert agent.state.recovery_error is None
    assert agent.state.session is not None
    assert agent.state.session.id == session_id
    assert agent.state.session.stage == "verified"
    assert client.get("/api/state", headers=headers).status_code == 401
    token = pair(client)
    headers = {"Authorization": f"Bearer {token}"}
    undone = client.post(
        f"/api/sessions/{session_id}/undo",
        headers=headers,
        json={"revision": approved.json()["revision"]},
    )
    assert undone.status_code == 200
    assert undone.json()["stage"] == "undone"
    assert (folder / "user_service.py").read_bytes() == original


def test_recovery_before_apply_and_after_undo(tmp_path, client):
    folder = project(tmp_path)
    assert client.post("/api/workspace", json={"path": str(folder)}).status_code == 200
    current = agent.state
    match = current.workspace.locate("user_service.py:2: TypeError")
    assert match is not None
    original = (folder / "user_service.py").read_bytes()
    patched = original.replace(b'return user["name"]', b'return "Unknown"')
    current.match = match
    current.session = Session(
        id="recovery-case",
        revision=2,
        stage="testing",
        source="text",
        error_text="user_service.py:2: TypeError",
    )
    current.original_bytes = original
    current.proposed_bytes = patched
    current.patched_sha = digest(patched)
    current.persist()

    before_apply = agent.AgentState()
    assert before_apply.recovery_error is None
    assert before_apply.session.stage == "analysis_failed"
    assert before_apply.patched_sha is None
    assert (folder / "user_service.py").read_bytes() == original

    before_apply.session.stage = "verified"
    before_apply.patched_sha = digest(patched)
    before_apply.original_bytes = original
    before_apply.proposed_bytes = patched
    before_apply.persist()
    after_undo = agent.AgentState()
    assert after_undo.session.stage == "undone"
    assert after_undo.patched_sha is None


def test_failed_source_write_does_not_trap_active_session(tmp_path, client, monkeypatch):
    folder = project(tmp_path)
    assert client.post("/api/workspace", json={"path": str(folder)}).status_code == 200
    current = agent.state
    match = current.workspace.locate("user_service.py:2: TypeError")
    assert match is not None
    original = (folder / "user_service.py").read_bytes()
    current.match = match
    current.proposed_bytes = original.replace(b'return user["name"]', b'return "Unknown"')
    proposal = Proposal(
        id="proposal",
        title="Fix",
        summary="Fix",
        risk="medium",
        files=[ProposedFile(path="user_service.py", diff="reviewed diff")],
        why="Cause",
        expected_effect="Test passes",
    )
    current.session = Session(
        id="failed-write",
        revision=2,
        stage="awaiting_approval",
        source="text",
        error_text="user_service.py:2: TypeError",
        proposal=proposal,
    )
    current.persist()
    token = pair(client)

    def fail_write(*_args):
        raise OSError("disk write failed")

    monkeypatch.setattr(agent, "atomic_write", fail_write)
    response = client.post(
        "/api/sessions/failed-write/approve",
        headers={"Authorization": f"Bearer {token}"},
        json={"proposal_id": "proposal", "revision": 2},
    )
    assert response.status_code == 200
    assert response.json()["stage"] == "failed"
    assert current.patched_sha is None
    assert (folder / "user_service.py").read_bytes() == original


def test_unpaired_phone_cannot_read_state_or_apply(tmp_path, client):
    project(tmp_path)
    client.post("/api/workspace", json={"path": str(tmp_path)})
    assert client.get("/api/state").status_code == 401
    assert client.post("/api/sessions", json={"error_text": "some error"}).status_code == 401


def test_ambiguous_file_is_not_patchable(tmp_path, client):
    first = tmp_path / "one"
    second = tmp_path / "two"
    first.mkdir()
    second.mkdir()
    (first / "Service.java").write_text("class Service {}")
    (second / "Service.java").write_text("class Service {}")
    client.post("/api/workspace", json={"path": str(tmp_path)})
    token = pair(client)
    headers = {"Authorization": f"Bearer {token}"}
    created = client.post(
        "/api/sessions",
        headers=headers,
        json={"error_text": "Service.java:1: NullPointerException", "source": "text"},
    )
    assert created.status_code == 202
    analyzed = asyncio.run(wait_stage(client, token, "root_cause_found"))
    assert analyzed["analysis"]["confidence"] == "low"
    assert analyzed["analysis"]["location"] is None
    assert (
        client.post(f"/api/sessions/{created.json()['id']}/proposal", headers=headers).status_code
        == 422
    )


def test_hash_guard_blocks_changed_source(tmp_path, client):
    folder = project(tmp_path)
    client.post("/api/workspace", json={"path": str(folder)})
    token = pair(client)
    headers = {"Authorization": f"Bearer {token}"}
    created = client.post(
        "/api/sessions",
        headers=headers,
        json={"error_text": "user_service.py:2: TypeError: NoneType is not subscriptable"},
    )
    asyncio.run(wait_stage(client, token, "root_cause_found"))
    client.post(f"/api/sessions/{created.json()['id']}/proposal", headers=headers)
    proposed = asyncio.run(wait_stage(client, token, "awaiting_approval"))
    (folder / "user_service.py").write_text(
        "# user edit\n" + (folder / "user_service.py").read_text()
    )
    response = client.post(
        f"/api/sessions/{created.json()['id']}/approve",
        headers=headers,
        json={"proposal_id": proposed["proposal"]["id"], "revision": proposed["revision"]},
    )
    assert response.status_code == 409
    assert (folder / "user_service.py").read_text().startswith("# user edit")


def test_workspace_excludes_generated_tree(tmp_path):
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "secret.py").write_text("print('bad')")
    (tmp_path / "source.py").write_text("print('good')")
    workspace = Workspace(str(tmp_path))
    assert list(workspace.files) == ["source.py"]


def test_stack_trace_targets_source_not_test(tmp_path):
    project(tmp_path)
    workspace = Workspace(str(tmp_path))
    match = workspace.locate("test_user_service.py:4: TypeError\nuser_service.py:2: TypeError")
    assert match is not None
    assert match.path == "user_service.py"
    assert match.line == 2
    assert workspace.locate("test_user_service.py:4: TypeError") is None


def test_ocr_spacing_recovers_explicit_known_source_frame(tmp_path):
    project(tmp_path)
    workspace = Workspace(str(tmp_path))
    captured = (
        "test_user_service. py:4: TypeError\n"
        "user_service. py : 2: TypeError: NoneType is not subscriptable\n"
    )
    match = workspace.locate(captured)
    assert match is not None
    assert match.path == "user_service.py"
    assert match.line == 2


def test_ocr_python_traceback_recovers_spaced_path_and_accented_line(tmp_path):
    folder = tmp_path / "demo" / "discount-case"
    folder.mkdir(parents=True)
    (folder / "pricing.py").write_text(
        "def total_after_discount(amount, percent):\n"
        "    return amount - (amount * percent // 100)\n"
    )
    workspace = Workspace(str(tmp_path))
    captured_path = str(folder / "pricing.py").replace("/", "\\")
    captured_path = captured_path.replace("\\pricing.py", " \\pricing. py")
    captured = (
        f'File "{captured_path}", líne 2, in total_after_discount\n'
        "TypeError: unsupported operand type(s) for *: 'int' and 'NoneType'"
    )

    match = workspace.locate(captured)

    assert match is not None
    assert match.path == "demo/discount-case/pricing.py"
    assert match.line == 2


def test_ocr_match_stays_strict_for_unknown_or_unlined_files(tmp_path):
    project(tmp_path)
    workspace = Workspace(str(tmp_path))
    assert workspace.locate("user_servlce. py:2: TypeError") is None
    assert workspace.locate("misuser_service.py:2: TypeError") is None
    assert workspace.locate("user_service.py: TypeError") is None
    assert workspace.locate("user_service.\npy:2: TypeError") is None
    assert workspace.locate("user_service.py:0: TypeError") is None
    assert workspace.locate("user_service.py:3: TypeError") is None
    assert workspace.locate("test_user_service. py:4: TypeError") is None


def test_ocr_session_gets_grounded_high_confidence(tmp_path, client):
    folder = project(tmp_path)
    assert client.post("/api/workspace", json={"path": str(folder)}).status_code == 200
    token = pair(client)
    headers = {"Authorization": f"Bearer {token}"}
    response = client.post(
        "/api/sessions",
        headers=headers,
        json={
            "error_text": "test_user_service. py:4: TypeError\nuser_service. py : 2: TypeError",
            "source": "camera",
        },
    )
    assert response.status_code == 202
    analyzed = asyncio.run(wait_stage(client, token, "root_cause_found"))
    assert analyzed["analysis"]["confidence"] == "high"
    assert analyzed["analysis"]["location"] == {"path": "user_service.py", "line": 2}


def test_nested_react_project_selects_its_own_allowlisted_tests(tmp_path):
    nested = tmp_path / "apps" / "web"
    nested.mkdir(parents=True)
    (tmp_path / "pyproject.toml").write_text("[project]\nname='root'\nversion='0.1'\n")
    (nested / "package.json").write_text('{"scripts":{"test":"vitest run"}}')
    (nested / "App.tsx").write_text("export const App = () => null;\n")
    workspace = Workspace(str(tmp_path))
    selected = workspace.test_command("apps/web/App.tsx")
    assert selected is not None
    assert selected[1] == "npm run test"
    assert selected[2] == nested


def test_unsafe_package_test_script_is_not_executed(tmp_path):
    (tmp_path / "package.json").write_text('{"scripts":{"test":"vitest run && echo unexpected"}}')
    (tmp_path / "App.tsx").write_text("export const App = () => null;\n")
    workspace = Workspace(str(tmp_path))
    assert workspace.test_command("App.tsx") is None
    assert workspace.verify("App.tsx").passed is False


@pytest.mark.skipif(shutil.which("npm") is None, reason="npm is not installed")
def test_node_project_runs_fixed_test_command(tmp_path):
    (tmp_path / "package.json").write_text('{"scripts":{"test":"node --test"}}')
    (tmp_path / "pricing.js").write_text("export const price = 100;\n")
    (tmp_path / "pricing.test.js").write_text(
        "const { test } = require('node:test');\n"
        "test('price', () => { require('node:assert').strictEqual(100, 100); });\n"
    )
    workspace = Workspace(str(tmp_path))
    validation = workspace.verify("pricing.js")
    assert validation.passed is True, validation.output
    assert validation.command == "npm run test"
