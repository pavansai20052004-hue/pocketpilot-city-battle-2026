import { useCallback, useEffect, useState } from "react";
import type { AgentState, PairingCode, Session } from "@pocketpilot/shared";

const initialState: AgentState = {
  workspace: { path: null, ready: false, files: 0 },
  provider: { name: "ollama", ready: false, model: "qwen3-coder:30b" },
  pairing: { connected_devices: 0 },
  session: null,
  history: [],
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

function formatDateTime(value: number): string {
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? "" : `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
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
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [openRouterModel, setOpenRouterModel] = useState("");
  const [activeSection, setActiveSection] = useState("overview");

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

  useEffect(() => {
    const sections = ["overview", "workspace", "connection", "session", "history"]
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActiveSection(visible[0].target.id);
      },
      { rootMargin: "-100px 0px -55% 0px", threshold: [0, 0.1, 0.25, 0.5] },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
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

  async function configureProvider(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const provider = await request<AgentState["provider"]>("/api/provider/config", {
        method: "POST",
        body: JSON.stringify({
          provider: "openrouter",
          api_key: openRouterKey,
          model: openRouterModel.trim(),
        }),
      });
      setState((current) => ({ ...current, provider }));
      setNotice("OpenRouter is active for error analysis, fix proposals, and Pilot chat.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not configure OpenRouter.");
    } finally {
      setOpenRouterKey("");
      setWorking(false);
    }
  }

  async function useLocalProvider() {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const provider = await request<AgentState["provider"]>("/api/provider/config", {
        method: "POST",
        body: JSON.stringify({ provider: "ollama" }),
      });
      setState((current) => ({ ...current, provider }));
      setNotice("All new AI requests now use local Ollama on this laptop.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not restore local Ollama.");
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

  async function confirmGitHubPublish(session: Session) {
    const publish = session.github_publish;
    if (!publish || publish.status !== "awaiting_desktop_confirmation") return;
    const approved = window.confirm(
      `Confirm this verified GitHub publish?\n\nRepository: ${publish.repository}\nBranch: ${publish.branch}\nFile: ${publish.path}\nCommit: ${publish.message}\n\nOnly this file will be committed. Existing Git hooks may run. GitHub credentials remain on this laptop.`,
    );
    if (!approved) return;
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await request<Session>(`/api/sessions/${session.id}/github/publish/confirm`, {
        method: "POST",
        body: JSON.stringify({ revision: session.revision }),
      });
      setState((current) => ({ ...current, session: updated }));
      setNotice("Desktop confirmed. PocketPilot is creating and pushing the reviewed one-file commit.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not confirm this GitHub publish.");
    } finally {
      setWorking(false);
    }
  }

  const session = state.session;
  const history = state.history ?? [];
  const busy = session?.stage === "analyzing" || session?.stage === "generating_fix" || session?.stage === "testing";
  const preflight = [
    connected,
    state.provider.ready,
    state.workspace.ready,
    state.pairing.connected_devices > 0,
  ];
  const preflightReady = preflight.every(Boolean);
  const cloudProvider = state.provider.name === "openrouter";
  const preflightMissing = [
    !connected && "desktop agent",
    !state.provider.ready && "AI provider",
    !state.workspace.ready && "workspace",
    state.pairing.connected_devices === 0 && "paired phone",
  ].filter(Boolean);

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Product navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">P<span>↗</span></span>
          <span className="brand-copy"><strong>POCKETPILOT</strong><small>LOCAL CONTROL</small></span>
        </div>
        <nav className="nav-list" aria-label="Sections">
          <a href="#overview" className={`nav-link ${activeSection === "overview" ? "active" : ""}`} aria-current={activeSection === "overview" ? "location" : undefined}><span>◈</span> Overview</a>
          <a href="#session" className={`nav-link ${activeSection === "session" ? "active" : ""}`} aria-current={activeSection === "session" ? "location" : undefined}><span>≡</span> Session</a>
          <a href="#workspace" className={`nav-link ${activeSection === "workspace" ? "active" : ""}`} aria-current={activeSection === "workspace" ? "location" : undefined}><span>⌘</span> Workspace</a>
          <a href="#connection" className={`nav-link ${activeSection === "connection" ? "active" : ""}`} aria-current={activeSection === "connection" ? "location" : undefined}><span>◎</span> Connection</a>
          <a href="#history" className={`nav-link ${activeSection === "history" ? "active" : ""}`} aria-current={activeSection === "history" ? "location" : undefined}><span>◷</span> History</a>
        </nav>
        <div className="sidebar-foot">
          <div className="privacy-dot" />
          <div><strong>Controlled execution</strong><small>Every file change needs approval</small></div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-label">POCKETPILOT <span>/</span> DESKTOP CONTROL</div>
          <span className={`top-status ${connected ? "online" : "offline"}`}>
            <i aria-hidden="true" /> {connected ? "AGENT ONLINE" : "AGENT OFFLINE"}
          </span>
        </header>

        <div className="content">
          <section id="overview" className="hero">
            <div className="hero-main"><p className="eyebrow"><span className="accent-line" /> LIVE WORKSPACE / CITY BATTLE 2026</p>
            <h1>Every fix, <em>under your control.</em></h1>
            <p className="hero-sub">Capture on the phone. Inspect and test on this laptop. Review the exact change before anything is written.</p></div>
            <div className="hero-meta">
              <span><b>01</b> CAPTURE</span>
              <span><b>02</b> ANALYZE</span>
              <span><b>03</b> APPROVE</span>
              <span><b>04</b> VERIFY &amp; UNDO</span>
            </div>
          </section>

          {error && <div className="alert error" role="alert"><span>!</span><p>{error}</p><button onClick={() => void refresh()}>RETRY</button></div>}
          {notice && <div className="alert notice" role="status"><span>✓</span><p>{notice}</p><button onClick={() => setNotice(null)} aria-label="Dismiss notice">×</button></div>}

          <section className="readiness" aria-label="Readiness">
            <div className="readiness-intro"><p className="eyebrow">01 / SYSTEM STATUS</p><h2>{preflightReady ? "Ready for a live run." : "Finish setup to begin."}</h2><p>Agent, model, project, and phone must be ready before a debug session.</p></div>
            <div className="readiness-items">
              <div className={connected ? "ready" : "attention"}><span className="readiness-icon">◎</span><small>DESKTOP AGENT</small><strong>{connected ? "Online" : "Offline"}</strong></div>
              <div className={state.provider.ready ? "ready" : "attention"}><span className="readiness-icon">◇</span><small>{cloudProvider ? "OPENROUTER" : "OLLAMA"}</small><strong>{state.provider.ready ? "Ready" : "Not ready"}</strong></div>
              <div className={state.workspace.ready ? "ready" : "attention"}><span className="readiness-icon">⌁</span><small>WORKSPACE</small><strong>{state.workspace.ready ? "Selected" : "Not selected"}</strong></div>
              <div className={state.pairing.connected_devices > 0 ? "ready" : "attention"}><span className="readiness-icon">▣</span><small>PHONES LINKED</small><strong>{state.pairing.connected_devices}</strong></div>
              <div className={preflightReady ? "ready" : "attention"}><span className="readiness-icon">✓</span><small>LIVE DEMO</small><strong>{preflightReady ? "Ready" : `${4 - preflightMissing.length}/4 ready`}</strong></div>
              {!preflightReady && <p className="readiness-note">Before the demo, confirm: {preflightMissing.join(" · ")}. This check is local and does not change project files.</p>}
            </div>
          </section>

          <section id="session" className="panel session-panel">
            <div className="panel-heading"><div><p className="eyebrow">02 / LIVE WORKFLOW</p><h2>Current debug session</h2></div><span className={`session-pill ${busy ? "busy" : ""}`}>{stateText(session?.stage)}</span></div>
            {session ? (
              <div className="session-content">
                <div className="session-headline"><span className="session-monogram">{busy ? "◌" : session.stage === "verified" ? "✓" : "↗"}</span><div><small>SESSION {session.id.slice(0, 8)}</small><h3>{session.analysis?.title || stateText(session.stage)}</h3></div></div>
                <div className="session-stats"><div><small>STAGE</small><strong>{stateText(session.stage)}</strong></div><div><small>REVISION</small><strong>{session.revision}</strong></div><div><small>LOCATION</small><strong className="mono">{session.analysis?.location ? `${session.analysis.location.path}:${session.analysis.location.line}` : "Awaiting evidence"}</strong></div></div>
                {session.error_message && <p className="inline-error">{session.error_message}</p>}
                {session.validation && <div className="validation-line"><span>{session.validation.passed ? "✓" : "!"}</span> {session.validation.passed ? "Approved change passed its checks" : "The checks did not pass"} · <code>{session.validation.command}</code></div>}
                {session.github_publish && <div className="github-line" aria-live="polite"><strong>GITHUB / {session.github_publish.status.replaceAll("_", " ").toUpperCase()}</strong>{session.github_publish.repository && <span>{session.github_publish.repository} · {session.github_publish.branch} · {session.github_publish.path}</span>}{session.github_publish.message && <span>Commit message: {session.github_publish.message}</span>}{session.github_publish.commit_sha && <code>{session.github_publish.commit_sha.slice(0, 12)}</code>}{session.github_publish.detail && <small>{session.github_publish.detail}</small>}{session.github_publish.status === "awaiting_desktop_confirmation" && <><small>Review the destination above. The paired phone cannot create or push a commit without this laptop-side approval.</small><button className="publish-confirm" disabled={working} onClick={() => void confirmGitHubPublish(session)}>CONFIRM COMMIT &amp; PUSH</button></>}<small>GitHub credentials stay on this laptop. Configured Git hooks may run during commit.</small></div>}
              </div>
            ) : (
              <div className="empty-session"><div className="empty-symbol">◌</div><div><h3>Waiting for a debug session</h3><p>Start on the iQOO. Analysis, approval, tests, and undo will appear here as they happen.</p></div></div>
            )}
          </section>

          <section className="pilot-banner" aria-label="Pilot voice assistant">
            <div className="pilot-banner-symbol" aria-hidden="true">✳</div>
            <div><p className="eyebrow">PILOT / EXPLAIN THE WORK</p><h2>Ask what happened.</h2><p>Speak from the phone to understand the active session. Pilot can explain the result; file changes still require your approval. {cloudProvider ? "OpenRouter processes this prompt outside your laptop; avoid sending secrets." : "Ollama processes the prompt locally on this laptop."}</p></div>
            <span className="pilot-banner-status">{state.provider.ready ? `${cloudProvider ? "CLOUD" : "LOCAL"} · ${state.provider.model}` : "AI PROVIDER OFFLINE"}</span>
          </section>

          <section className="panel provider-panel" aria-label="AI provider settings">
            <div className="panel-heading"><div><p className="eyebrow">AI ROUTE / ALL FEATURES</p><h2>{cloudProvider ? "OpenRouter is active." : "Choose your model route."}</h2></div><span className="panel-symbol">◇</span></div>
            {cloudProvider ? <>
              <div className="cloud-egress" role="note"><strong>CLOUD PROCESSING IS ON</strong><p>Error text, the matched source-file window, fix instructions, and Pilot messages are sent to OpenRouter for all model calls. Common credential patterns are redacted, but that cannot guarantee every secret is removed. Review inputs and do not submit credentials.</p></div>
              <p className="panel-copy">The API key is held only in the laptop agent’s memory until that agent stops; it is not saved to the app, phone, or repository.</p>
              <button type="button" className="secondary-button" disabled={working} onClick={() => void useLocalProvider()}>SWITCH BACK TO LOCAL OLLAMA</button>
            </> : <>
              <p className="panel-copy">Local Ollama keeps prompts on this laptop. To use your event credits for every AI action, enter the model slug shown in the OpenRouter event page and your API key below.</p>
              <div className="cloud-egress" role="note"><strong>BEFORE SWITCHING</strong><p>With OpenRouter active, error text, a bounded source-file window, and Pilot conversation context leave this laptop. The API key is sent only to OpenRouter and stored only in laptop-agent memory for this run.</p></div>
              <form onSubmit={(event) => void configureProvider(event)} className="provider-form">
                <label htmlFor="openrouter-model">RECOMMENDED MODEL SLUG</label>
                <input id="openrouter-model" autoComplete="off" autoCapitalize="none" spellCheck={false} value={openRouterModel} onChange={(event) => setOpenRouterModel(event.target.value)} placeholder="provider/model-name" required />
                <label htmlFor="openrouter-key">OPENROUTER API KEY</label>
                <input id="openrouter-key" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={openRouterKey} onChange={(event) => setOpenRouterKey(event.target.value)} placeholder="Paste the key here; it will be cleared after submit" required />
                <button type="submit" disabled={working || !connected}>{working ? "VERIFYING KEY…" : "USE OPENROUTER FOR ALL AI"}</button>
              </form>
            </>}
          </section>

          <div className="grid">
            <section id="workspace" className="panel workspace-panel">
              <div className="panel-heading"><div><p className="eyebrow">03 / PROJECT BOUNDARY</p><h2>Select a workspace</h2></div><span className="panel-symbol">⌘</span></div>
              <p className="panel-copy">Choose the project you want PocketPilot to inspect. Files outside this folder stay out of reach.</p>
              <form onSubmit={(event) => void selectWorkspace(event)}>
                <label htmlFor="workspace-path">FOLDER PATH</label>
                <div className="field-row"><input id="workspace-path" spellCheck={false} value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="C:\Projects\my-app" required /><button type="submit" disabled={working || !connected}>INSPECT PROJECT <span>↗</span></button></div>
              </form>
              <div className="panel-footer"><span className="live-dot" /> {state.workspace.ready ? `${state.workspace.files} eligible source files found` : "Nothing is modified by inspection"}</div>
            </section>

            <section id="connection" className="panel connection-panel">
              <div className="panel-heading"><div><p className="eyebrow">04 / SECURE PAIRING</p><h2>Connect the iQOO</h2></div><span className="panel-symbol">◎</span></div>
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

          <section id="history" className="panel session-panel history-panel">
            <div className="panel-heading"><div><p className="eyebrow">05 / PRIVATE ARCHIVE</p><h2>Recent sessions</h2></div><span className="panel-symbol">◷</span></div>
            <p className="panel-copy">Up to 25 completed outcomes saved on this laptop. Error logs, source code, diffs, and test output are excluded.</p>
            {history.length ? <div className="history-list">{history.map(item => (
              <article className="history-item" key={item.id}>
                <div className="history-item-top"><span className={`history-stage ${item.stage}`}>{stateText(item.stage)}</span><time>{formatDateTime(item.updated_at)}</time></div>
                <h3>{item.title}</h3>
                <div className="history-item-meta"><span>{item.source.toUpperCase()} INPUT</span><span className="mono">{item.location ? `${item.location.path}:${item.location.line}` : "No source location"}</span><span>{item.check_passed === null ? "No check run" : item.check_passed ? "Check passed" : "Check failed"}</span>{item.github_status && <span>GitHub {item.github_status.replaceAll("_", " ")}{item.repository ? ` · ${item.repository}` : ""}{item.commit_sha ? ` · ${item.commit_sha.slice(0, 8)}` : ""}</span>}</div>
              </article>
            ))}</div> : <div className="history-empty"><strong>No completed sessions yet.</strong><span>After a run finishes, its outcome will appear here.</span></div>}
            {state.history_error && <p className="inline-error">{state.history_error}</p>}
          </section>

          <footer className="footer"><span>POCKETPILOT AI / CITY BATTLE 2026</span><span>SEE IT. SAY IT. FIX IT. <b>HUMAN IN CONTROL.</b></span></footer>
        </div>
      </main>
    </div>
  );
}

export default App;
