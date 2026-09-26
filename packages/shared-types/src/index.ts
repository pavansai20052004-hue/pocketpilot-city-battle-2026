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
}

export interface AgentState {
  workspace: { path: string | null; ready: boolean; files: number };
  provider: { ready: boolean; model: string };
  pairing: { connected_devices: number };
  session: Session | null;
}

export interface Health {
  status: "ok";
  model: string;
  ollama_ready: boolean;
}

export interface PairResponse {
  token: string;
  device_name: string;
}

export interface PairingCode {
  code: string;
  expires_at: number;
}
