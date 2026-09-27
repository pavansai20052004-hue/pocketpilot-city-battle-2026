import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentRoot = path.join(root, "services", "agent");
const desktopRoot = path.join(root, "apps", "desktop-web");
const agentPort = 8000;
const dashboardPort = 4173;
const agentHealthUrl = `http://127.0.0.1:${agentPort}/api/health`;
const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
const checkOnly = process.argv.includes("--check");
const python = path.join(
  agentRoot,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);
const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
const children = [];
let stopRequested = false;
let resolveStop;
let stopPromise;

const stopSignal = new Promise((resolve) => {
  resolveStop = resolve;
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readAgentHealth(timeoutMs = 1500) {
  try {
    const response = await fetch(agentHealthUrl, {
      signal: AbortSignal.timeout(Math.min(timeoutMs, 1500)),
    });
    if (!response.ok) return null;
    const health = await response.json();
    return health.status === "ok" ? health : null;
  } catch {
    return null;
  }
}

async function dashboardIsReady(timeoutMs = 1500) {
  try {
    const response = await fetch(dashboardUrl, {
      signal: AbortSignal.timeout(Math.min(timeoutMs, 1500)),
    });
    if (!response.ok) return false;
    return (await response.text()).includes("PocketPilot");
  } catch {
    return false;
  }
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(700);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function startChild(command, args, cwd, label, env = process.env) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  child.label = label;
  children.push(child);
  child.once("error", (error) => {
    console.error(`${label} could not start: ${error.message}`);
    requestStop();
  });
  child.once("exit", (code, signal) => {
    if (!stopRequested) {
      console.error(`${label} stopped unexpectedly (code ${code ?? "-"}, signal ${signal ?? "-"}).`);
      requestStop();
    }
  });
  return child;
}

function requestStop(exitCode = 1) {
  if (stopRequested) return;
  stopRequested = true;
  process.exitCode = exitCode;
  resolveStop();
  void stopStartedServices();
}

async function waitUntil(check, child, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (stopRequested) throw new Error("Startup interrupted.");
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before becoming ready.`);
    }
    const remainingMs = Math.max(1, deadline - Date.now());
    if (await check(remainingMs)) {
      if (stopRequested) throw new Error("Startup interrupted.");
      return;
    }
    await delay(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`${label} did not become ready within 20 seconds.`);
}

function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function terminateChild(child) {
  if (!childIsRunning(child)) return Promise.resolve();
  if (process.platform !== "win32" || !child.pid) {
    child.kill();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, 5000);
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => {
      child.kill();
      finish();
    });
    killer.once("exit", () => {
      if (childIsRunning(child)) child.kill();
      finish();
    });
  });
}

function stopStartedServices() {
  if (!stopPromise) {
    stopPromise = (async () => {
      for (const child of [...children].reverse()) await terminateChild(child);
    })();
  }
  return stopPromise;
}

function runBuildCommand(args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  children.push(child);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      children.splice(children.indexOf(child), 1);
      if (error) reject(error);
      else resolve();
    };
    child.once("error", (error) => {
      finish(error);
    });
    child.once("exit", (code) => {
      if (stopRequested) finish(new Error("Startup interrupted."));
      else if (code === 0) finish();
      else finish(new Error("Desktop dashboard build failed; it was not started."));
    });
  });
}

async function buildDesktop() {
  if (!existsSync(tsc)) throw new Error("TypeScript is missing. Run npm install from the project root first.");
  await runBuildCommand([tsc, "-p", path.join(root, "packages", "shared-types", "tsconfig.json")], root);
  if (stopRequested) throw new Error("Startup interrupted.");
  await runBuildCommand([tsc, "-b"], desktopRoot);
  if (stopRequested) throw new Error("Startup interrupted.");
  await runBuildCommand([vite, "build"], desktopRoot);
}

function agentEnvironment() {
  const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" };
  const userProfile = process.env.USERPROFILE;
  const localDotnet = userProfile && path.join(userProfile, "Tools", "dotnet");
  if (localDotnet && existsSync(path.join(localDotnet, "dotnet.exe"))) {
    env.PATH = `${localDotnet}${path.delimiter}${env.PATH ?? ""}`;
    env.DOTNET_ROOT = localDotnet;
  }
  return env;
}

function printHealth(agent, dashboard) {
  console.log(`Desktop dashboard: ${dashboard ? "READY" : "OFFLINE"} (${dashboardUrl})`);
  console.log(`Laptop agent: ${agent ? "READY" : "OFFLINE"} (${agentHealthUrl})`);
  if (agent) {
    console.log(`Local model: ${agent.ollama_ready ? `READY (${agent.model})` : "OFFLINE"}`);
  }
}

async function main() {
  if (!existsSync(python)) {
    throw new Error(
      `Python environment not found at ${python}. Set up services/agent/.venv using services/agent/README.md.`,
    );
  }
  if (!existsSync(vite)) {
    throw new Error("Desktop dependencies are missing. Run npm install from the project root first.");
  }

  let agent = await readAgentHealth();
  let dashboard = await dashboardIsReady();
  if (stopRequested) return;
  if (checkOnly) {
    printHealth(agent, dashboard);
    if (!agent || !dashboard || !agent.ollama_ready) process.exitCode = 1;
    return;
  }

  if (!agent) {
    if (await portIsOpen(agentPort)) {
      throw new Error(`Port ${agentPort} is occupied by a service that is not PocketPilot's health API.`);
    }
    if (stopRequested) return;
    const child = startChild(
      python,
      ["-m", "uvicorn", "pocketpilot_agent.main:app", "--host", "0.0.0.0", "--port", String(agentPort)],
      agentRoot,
      "PocketPilot laptop agent",
      agentEnvironment(),
    );
    await waitUntil(async (timeoutMs) => Boolean(await readAgentHealth(timeoutMs)), child, "Laptop agent");
    agent = await readAgentHealth();
  }

  if (!dashboard) {
    if (await portIsOpen(dashboardPort)) {
      throw new Error(`Port ${dashboardPort} is occupied by a page that is not PocketPilot.`);
    }
    if (stopRequested) return;
    await buildDesktop();
    if (stopRequested) return;

    const child = startChild(
      process.execPath,
      [vite, "preview", "--host", "127.0.0.1", "--port", String(dashboardPort), "--strictPort"],
      desktopRoot,
      "PocketPilot desktop dashboard",
    );
    await waitUntil(dashboardIsReady, child, "Desktop dashboard");
    dashboard = await dashboardIsReady();
  }

  printHealth(agent, dashboard);
  if (!agent?.ollama_ready) {
    console.warn("Ollama is not ready. The dashboard and pairing can run, but local AI actions will need Ollama.");
  }
  if (children.length === 0) {
    console.log("Both services were already running; no processes were started by this helper.");
    return;
  }
  console.log("PocketPilot is ready for the paired phone. Use trusted private Wi-Fi only.");
  console.log("Press Ctrl+C here to stop only the services started by this helper.");
  await stopSignal;
  await stopStartedServices();
}

process.once("SIGINT", () => requestStop(130));
process.once("SIGTERM", () => requestStop(143));

main().catch(async (error) => {
  if (!stopRequested) console.error(`PocketPilot could not start: ${error.message}`);
  await stopStartedServices();
  if (!stopRequested) process.exitCode = 1;
});
