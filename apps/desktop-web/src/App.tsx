import { useCallback, useEffect, useState } from "react";
import type { AgentState, PairingCode, Session } from "@pocketpilot/shared";

const initialState: AgentState = {
  workspace: { path: null, ready: false, files: 0 },
  provider: { ready: false, model: "qwen3-coder:30b" },
  pairing: { connected_devices: 0 },
  session: null,
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(data?.detail ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function stateText(stage: Session["stage"] | undefined): string {
  if (!stage) return "No active session";
  const labels: Record<Session["stage"], string> = {
    analyzing: "Analyzing error",
    root_cause_found: "Root cause found",
    analysis_failed: "Analysis needs attention",
    generating_fix: "Designing a safe fix",
    awaiting_approval: "Awaiting your approval",
    testing: "Running approved checks",
    verified: "Fix verified",
    failed: "Check failed",
    undone: "Fix undone",
  };
  return labels[stage];
}

function formatTime(value: number | null): string {
  if (!value) return "";
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function App() {
  const [state, setState] = useState<AgentState>(initialState);
  const [workspacePath, setWorkspacePath] = useState("");
  const [code, setCode] = useState<PairingCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [lanAddress, setLanAddress] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const next = await request<AgentState>("/api/dashboard");
      setState(next);
      setConnected(true);
      setError(null);
      setWorkspacePath((current) => current || next.workspace.path || "");
    } catch (caught) {
      setConnected(false);
      setError(caught instanceof Error ? caught.message : "The local agent is not responding.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    // The browser cannot reliably discover the laptop's LAN IP. This field is intentionally
    // user-supplied rather than showing loopback as a phone-reachable address.
    const saved = window.localStorage.getItem("pocketpilot.lanAddress");
    if (saved) setLanAddress(saved);
  }, []);

  async function selectWorkspace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setNotice(null);
    setError(null);
    try {
      const next = await request<AgentState>("/api/workspace", {
        method: "POST",
        body: JSON.stringify({ path: workspacePath.trim() }),
      });
      setState(next);
      setNotice("Workspace selected. The agent will inspect only this folder.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not select that workspace.");
    } finally {
      setWorking(false);
    }
  }

  async function createPairingCode() {
    setWorking(true);
    setError(null);
    try {
      const next = await request<PairingCode>("/api/pairing-code", { method: "POST" });
      setCode(next);
      setNotice("Enter this one-time code in PocketPilot on the iQOO.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create a pairing code.");
    } finally {
      setWorking(false);
    }
  }

  const session = state.session;
  const busy = session?.stage === "analyzing" || session?.stage === "generating_fix" || session?.stage === "testing";

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Product navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">P<span>↗</span></span>
          <span className="brand-copy"><strong>POCKETPILOT</strong><small>LOCAL CONTROL</small></span>
        </div>
        <nav className="nav-list" aria-label="Sections">
          <a href="#overview" className="nav-link active"><span>◈</span> Overview</a>
          <a href="#workspace" className="nav-link"><span>⌘</span> Workspace</a>
          <a href="#connection" className="nav-link"><span>◎</span> Connection</a>
          <a href="#session" className="nav-link"><span>≡</span> Session</a>
        </nav>
        <div className="sidebar-foot">
          <div className="privacy-dot" />
          <div><strong>Private by design</strong><small>Local agent · Human-approved edits</small></div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-label">CITY BATTLE / DESKTOP AGENT</div>
          <span className={`top-status ${connected ? "online" : "offline"}`}>
            <i aria-hidden="true" /> {connected ? "AGENT ONLINE" : "AGENT OFFLINE"}
          </span>
        </header>

        <div className="content">
          <section id="overview" className="hero">
            <p className="eyebrow"><span className="accent-line" /> PHONE-FIRST DEVELOPER TOOL</p>
            <h1>See the error.<br /><em>Keep control.</em></h1>
            <p className="hero-sub">Your iQOO drives the workflow. This laptop holds the code, runs the local model, and applies only the fix you approve.</p>
            <div className="hero-rule" />
            <div className="hero-meta">
              <span><b>01</b> CONNECT THE PHONE</span>
              <span><b>02</b> SELECT A PROJECT</span>
              <span><b>03</b> DEBUG SAFELY</span>
            </div>
            <div className="hero-orbit" aria-hidden="true"><div className="hero-orbit-inner">P</div></div>
          </section>

          {error && <div className="alert error" role="alert"><span>!</span><p>{error}</p><button onClick={() => void refresh()}>RETRY</button></div>}
          {notice && <div className="alert notice" role="status"><span>✓</span><p>{notice}</p><button onClick={() => setNotice(null)} aria-label="Dismiss notice">×</button></div>}

          <section className="readiness" aria-label="Readiness">
            <div className="readiness-intro"><p className="eyebrow">SYSTEM READINESS</p><h2>Everything in view.</h2><p>No hidden steps. You always know what is connected and what can change.</p></div>
            <div className="readiness-items">
              <div><span className="readiness-icon">◎</span><small>LOCAL AGENT</small><strong>{connected ? "Ready" : "Offline"}</strong></div>
              <div><span className="readiness-icon">◇</span><small>LOCAL MODEL</small><strong>{state.provider.ready ? "Ready" : "Not ready"}</strong></div>
              <div><span className="readiness-icon">⌁</span><small>WORKSPACE</small><strong>{state.workspace.ready ? "Selected" : "Not selected"}</strong></div>
              <div><span className="readiness-icon">▣</span><small>PHONES PAIRED</small><strong>{state.pairing.connected_devices}</strong></div>
            </div>
          </section>

          <div className="grid">
            <section id="workspace" className="panel workspace-panel">
              <div className="panel-heading"><div><p className="eyebrow">01 / PROJECT BOUNDARY</p><h2>Select a workspace</h2></div><span className="panel-symbol">⌘</span></div>
              <p className="panel-copy">Choose the project you want PocketPilot to inspect. Files outside this folder stay out of reach.</p>
              <form onSubmit={(event) => void selectWorkspace(event)}>
                <label htmlFor="workspace-path">FOLDER PATH</label>
                <div className="field-row"><input id="workspace-path" spellCheck={false} value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="C:\Projects\my-app" required /><button type="submit" disabled={working || !connected}>INSPECT PROJECT <span>↗</span></button></div>
              </form>
              <div className="panel-footer"><span className="live-dot" /> {state.workspace.ready ? `${state.workspace.files} eligible source files found` : "Nothing is modified by inspection"}</div>
            </section>

            <section id="connection" className="panel connection-panel">
              <div className="panel-heading"><div><p className="eyebrow">02 / SECURE PAIRING</p><h2>Connect the iQOO</h2></div><span className="panel-symbol">◎</span></div>
              <p className="panel-copy">Office Kit connects your device to this laptop. PocketPilot also needs its own short-lived pairing code for app actions.</p>
              <label htmlFor="lan-address">LAPTOP LAN ADDRESS FOR PHONE</label>
              <input id="lan-address" spellCheck={false} value={lanAddress} onChange={(event) => { setLanAddress(event.target.value); window.localStorage.setItem("pocketpilot.lanAddress", event.target.value); }} placeholder="e.g. 192.168.1.5:8000" />
              <div className="code-row">
                <div><small>ONE-TIME CODE</small><strong className="pair-code">{code?.code ?? "— — — — — —"}</strong><small>{code ? `Expires ${formatTime(code.expires_at)}` : "Not generated yet"}</small></div>
                <button className="outline-button" onClick={() => void createPairingCode()} disabled={working || !connected}>NEW CODE <span>↗</span></button>
              </div>
              <div className="panel-footer"><span className="live-dot" /> {state.pairing.connected_devices} device{state.pairing.connected_devices === 1 ? "" : "s"} connected</div>
            </section>
          </div>

          <section id="session" className="panel session-panel">
            <div className="panel-heading"><div><p className="eyebrow">03 / LIVE WORKFLOW</p><h2>Current debug session</h2></div><span className={`session-pill ${busy ? "busy" : ""}`}>{stateText(session?.stage)}</span></div>
            {session ? (
              <div className="session-content">
                <div className="session-headline"><span className="session-monogram">{busy ? "◌" : session.stage === "verified" ? "✓" : "↗"}</span><div><small>SESSION {session.id.slice(0, 8)}</small><h3>{session.analysis?.title || stateText(session.stage)}</h3></div></div>
                <div className="session-stats"><div><small>STAGE</small><strong>{stateText(session.stage)}</strong></div><div><small>REVISION</small><strong>{session.revision}</strong></div><div><small>LOCATION</small><strong className="mono">{session.analysis?.location ? `${session.analysis.location.path}:${session.analysis.location.line}` : "Awaiting evidence"}</strong></div></div>
                {session.error_message && <p className="inline-error">{session.error_message}</p>}
                {session.validation && <div className="validation-line"><span>{session.validation.passed ? "✓" : "!"}</span> {session.validation.passed ? "Approved change passed its checks" : "The checks did not pass"} · <code>{session.validation.command}</code></div>}
              </div>
            ) : (
              <div className="empty-session"><div className="empty-symbol">◌</div><div><h3>Waiting for a debug session</h3><p>Start on the iQOO. Analysis, approval, tests, and undo will appear here as they happen.</p></div></div>
            )}
          </section>

          <footer className="footer"><span>POCKETPILOT AI / CITY BATTLE 2026</span><span>SEE IT. SAY IT. FIX IT. <b>HUMAN IN CONTROL.</b></span></footer>
        </div>
      </main>
    </div>
  );
}

export default App;
