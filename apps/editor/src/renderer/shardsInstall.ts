// Install on save: saving one of Shards' rooms puts it in the game on the local
// Shards stack (src/main/shardsInstall.ts). On unless turned off in Preferences;
// kept apart from Prefs, which agents share (agentProtocol.ts AgentPrefs).

import { host, type InstallResult } from "./host.ts";
import { notify } from "./store.ts";

const KEY = "meridian-editor.installOnSave";

export function installOnSave(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setInstallOnSave(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Not kept: on for the next session
  }
}

/** After `id` was saved as `text`: puts it in the game, and says how that went. */
export async function installAfterSave(id: string, text: string): Promise<void> {
  if (!installOnSave()) return;
  let result: InstallResult | null;
  try {
    result = await host.installRoom(id, text);
  } catch (e) {
    notify(`Saved, but not installed: ${(e as Error).message}`, "error");
    return;
  }
  if (result) notify(describeInstall(result), result.serverError ? "error" : "info");
}

export function describeInstall(r: InstallResult): string {
  const rebuilt = r.rooms.filter((x) => x.recreated).map((x) => x.rid);
  if (r.serverError) return `Installed ${r.roo}, but the server wasn't told: ${r.serverError}`;
  if (!r.rooms.length) return `Installed ${r.roo}; no room class uses it yet, so the server has nothing to rebuild (${r.ms} ms)`;
  if (!rebuilt.length) return `Installed ${r.roo}; none of its rooms (RID ${r.rooms.map((x) => x.rid).join(", ")}) is loaded on the server (${r.ms} ms)`;
  return `Installed ${r.roo} and rebuilt RID ${rebuilt.join(", ")} on the server (${r.ms} ms)`;
}
