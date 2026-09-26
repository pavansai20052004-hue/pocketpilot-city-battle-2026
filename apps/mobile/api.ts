export type Analysis = {
  title: string;
  confidence: 'high' | 'medium' | 'low';
  location: { path: string; line: number } | null;
  problem: string;
  evidence: string;
  repair_strategy: string;
};

export type Proposal = {
  id: string;
  title: string;
  summary: string;
  risk: string;
  files: { path: string; diff: string }[];
  why: string;
  expected_effect: string;
};

export type Validation = {
  passed: boolean;
  command: string;
  exit_code: number | null;
  output: string;
};

export type Session = {
  id: string;
  revision: number;
  stage:
    | 'analyzing'
    | 'root_cause_found'
    | 'analysis_failed'
    | 'generating_fix'
    | 'awaiting_approval'
    | 'testing'
    | 'verified'
    | 'failed'
    | 'undone';
  source: string;
  error_text: string;
  analysis: Analysis | null;
  proposal: Proposal | null;
  validation: Validation | null;
  error_message: string | null;
};

export type AgentState = {
  workspace: { path: string | null; ready: boolean; files: number } | null;
  provider: { ready: boolean; model: string } | null;
  pairing?: unknown;
  session: Session | null;
};

export type PairResult = { token: string; device_name: string };

export function normalizeAgentAddress(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Enter the laptop address shown on the desktop dashboard.');
  const full = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(full);
  } catch {
    throw new Error('Enter an address such as 192.168.1.10:8000.');
  }
  if (!url.hostname || !url.port || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error('Include the laptop address and port, for example 192.168.1.10:8000.');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use only the laptop address and port shown by PocketPilot.');
  }
  return url.origin;
}

export async function request<T>(baseUrl: string, path: string, token?: string, body?: object, timeoutMs = 12000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      if (!response.ok) throw new Error(`Laptop agent returned HTTP ${response.status}.`);
      throw new Error('The laptop agent returned an unreadable response.');
    }
    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && 'detail' in payload ? String(payload.detail) : `HTTP ${response.status}`;
      throw new Error(detail);
    }
    return payload as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The laptop did not respond in time. Check that both devices remain connected.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
