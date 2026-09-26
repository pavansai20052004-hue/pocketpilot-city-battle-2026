export type Stage =
  | "analyzing"
  | "root_cause_found"
  | "analysis_failed"
  | "generating_fix"
  | "awaiting_approval"
  | "testing"
  | "verified"
  | "failed"
  | "undone";

export interface SourceLocation {
  path: string;
  line: number;
}

export interface Analysis {
  title: string;
  confidence: "high" | "medium" | "low";
  location: SourceLocation | null;
  problem: string;
  evidence: string;
  repair_strategy: string;
}

export interface ProposedFile {
  path: string;
  diff: string;
}

export interface Proposal {
  id: string;
  title: string;
  summary: string;
  risk: "low" | "medium" | "high";
  files: ProposedFile[];
  why: string;
  expected_effect: string;
}

export interface Validation {
  passed: boolean;
  command: string;
  exit_code: number | null;
  output: string;
}

export interface GitHubPublishState {
  status:
    | "waiting"
    | "ready"
    | "unavailable"
    | "awaiting_desktop_confirmation"
    | "committing"
    | "pushing"
    | "pushed"
    | "commit_failed"
    | "upload_failed";
  repository: string | null;
  branch: string | null;
  path: string | null;
  commit_sha: string | null;
  message: string | null;
  detail: string | null;
}

export interface Session {
  id: string;
  revision: number;
  stage: Stage;
  source: string;
  error_text: string;
  analysis: Analysis | null;
  proposal: Proposal | null;
  validation: Validation | null;
  error_message: string | null;
  github_publish: GitHubPublishState | null;
}

export interface SessionHistoryItem {
  id: string;
  stage: Stage;
  source: string;
  title: string;
  location: SourceLocation | null;
  check_passed: boolean | null;
  check_command: string | null;
  updated_at: number;
  github_status: GitHubPublishState["status"] | null;
  repository: string | null;
  branch: string | null;
  commit_sha: string | null;
}

export interface AgentState {
  workspace: { path: string | null; ready: boolean; files: number };
  provider: { ready: boolean; model: string };
  pairing: { connected_devices: number };
  session: Session | null;
  history: SessionHistoryItem[];
  history_error?: string | null;
}

export interface Health {
  status: "ok";
  model: string;
  ollama_ready: boolean;
}

export interface PairResponse {
  token: string;
  device_name: string;
  expires_at: number;
}

export interface PairingCode {
  code: string;
  expires_at: number;
}
