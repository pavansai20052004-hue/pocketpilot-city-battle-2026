"""Public API contracts for the local agent."""

from typing import Literal

from pydantic import BaseModel, Field

Stage = Literal[
    "analyzing",
    "root_cause_found",
    "analysis_failed",
    "generating_fix",
    "awaiting_approval",
    "testing",
    "verified",
    "failed",
    "undone",
]


class Location(BaseModel):
    path: str
    line: int = Field(ge=1)


class Analysis(BaseModel):
    title: str
    confidence: Literal["high", "medium", "low"]
    location: Location | None
    problem: str
    evidence: str
    repair_strategy: str


class ProposedFile(BaseModel):
    path: str
    diff: str


class Proposal(BaseModel):
    id: str
    title: str
    summary: str
    risk: Literal["low", "medium", "high"]
    files: list[ProposedFile]
    why: str
    expected_effect: str


class Validation(BaseModel):
    passed: bool
    command: str
    exit_code: int | None
    output: str


class GitHubPublishState(BaseModel):
    status: Literal[
        "waiting",
        "ready",
        "unavailable",
        "awaiting_desktop_confirmation",
        "committing",
        "pushing",
        "pushed",
        "commit_failed",
        "upload_failed",
    ] = "waiting"
    repository: str | None = None
    branch: str | None = None
    path: str | None = None
    commit_sha: str | None = None
    message: str | None = None
    detail: str | None = None


class Session(BaseModel):
    id: str
    revision: int
    stage: Stage
    source: str
    error_text: str
    analysis: Analysis | None = None
    proposal: Proposal | None = None
    validation: Validation | None = None
    error_message: str | None = None
    github_publish: GitHubPublishState | None = None


class SessionHistoryItem(BaseModel):
    """Small local-only session summary; never includes logs, diffs, or source."""

    id: str
    stage: Stage
    source: str
    title: str
    location: Location | None = None
    check_passed: bool | None = None
    check_command: str | None = None
    updated_at: int = Field(ge=0)
    github_status: str | None = None
    repository: str | None = None
    branch: str | None = None
    commit_sha: str | None = None


class PairRequest(BaseModel):
    code: str = Field(min_length=6, max_length=12)
    device_name: str = Field(min_length=1, max_length=80)


class WorkspaceRequest(BaseModel):
    path: str = Field(min_length=1, max_length=1024)


class NewSessionRequest(BaseModel):
    error_text: str = Field(min_length=8, max_length=20_000)
    source: str = Field(default="text", max_length=40)


class ApprovalRequest(BaseModel):
    proposal_id: str
    revision: int = Field(ge=1)


class UndoRequest(BaseModel):
    revision: int = Field(ge=1)


class GitHubPublishRequest(BaseModel):
    revision: int = Field(ge=1)
    message: str = Field(min_length=1, max_length=200)


class PublishConfirmationRequest(BaseModel):
    revision: int = Field(ge=1)
