// Where a running editor says how to reach it: agent.json in the editor's data
// folder (agent-web.json for the web build's dev server). Node only; shared by
// the Electron main process, the Vite dev server and packages/agent.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEndpoint } from "./agentProtocol.ts";

/** Electron's appData folder, worked out without Electron. */
export function appDataDir(): string {
  if (process.platform === "win32") return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

/** The installed editor's data folder, and the one development runs use (main.ts). */
export const EDITOR_DATA = "Meridian Room Editor";
export const EDITOR_DEV_DATA = "Meridian Room Editor (dev)";

/** Every place an endpoint file can be, likeliest first: development Electron, installed Electron, the web build. */
export function endpointFiles(): string[] {
  const base = appDataDir();
  return [join(base, EDITOR_DEV_DATA, "agent.json"), join(base, EDITOR_DATA, "agent.json"), join(base, EDITOR_DEV_DATA, "agent-web.json")];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The endpoints of editors that are running now. */
export function runningEndpoints(): (AgentEndpoint & { file: string })[] {
  return endpointFiles().flatMap((file) => {
    if (!existsSync(file)) return [];
    try {
      const e = JSON.parse(readFileSync(file, "utf8")) as AgentEndpoint;
      return alive(e.pid) ? [{ ...e, file }] : [];
    } catch {
      return [];
    }
  });
}

export function writeEndpoint(file: string, endpoint: AgentEndpoint): () => void {
  writeFileSync(file, JSON.stringify(endpoint, null, 2), { mode: 0o600 });
  return () => {
    try {
      const now = JSON.parse(readFileSync(file, "utf8")) as AgentEndpoint;
      if (now.pid === endpoint.pid && now.url === endpoint.url) rmSync(file);
    } catch {
      // Already gone.
    }
  };
}
