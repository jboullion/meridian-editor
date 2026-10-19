// Install on save: saving one of Shards' rooms puts it in the game on the local
// Shards stack (src/main/shardsInstall.ts). On unless turned off in Preferences;
// kept apart from Prefs, which agents share (agentProtocol.ts AgentPrefs).
// When the save also changed the room's Kod (its exits), the server builds and
// reloads the Kod, after asking: "reload system" saves the game.

import { confirmDialog } from "./dialogs.tsx";
import { baseName, host, type InstallResult, type KodLoadResult } from "./host.ts";
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

/** After `id` was saved as `text` (and the Kod files `kod` with it): puts it in the game, and says how that went. */
export async function installAfterSave(id: string, text: string, kod: readonly string[] = []): Promise<void> {
  const kodNames = kod.map(baseName).join(", ");
  if (!installOnSave()) {
    if (kod.length) notify(`Saved ${kodNames}. Install on save is off, so the server still runs the old Kod.`);
    return;
  }
  let result: InstallResult | null;
  try {
    result = await host.installRoom(id, text);
  } catch (e) {
    notify(`Saved, but not installed: ${(e as Error).message}`, "error");
    return;
  }
  if (!result) {
    if (kod.length) notify(`Saved ${kodNames}. The room isn't one of Shards' rooms, so nothing was loaded on the server.`);
    return;
  }
  notify(describeInstall(result), result.serverError ? "error" : "info");
  if (!kod.length || result.serverError) return;
  const go = await confirmDialog(
    "Load the Kod change?",
    `The save changed ${kodNames}. To use it, the server builds the Kod (about half a minute) and runs "reload system", which saves the game and reloads all the Kod; players stay connected. Then ${result.roo.replace(/\.roo$/, "")} makes its exits again.`,
    "Build and reload",
  );
  if (!go) {
    notify(`Installed ${result.roo}. ${kodNames} is saved but not loaded: the server runs the old exits until the Kod is rebuilt and reloaded.`);
    return;
  }
  notify(`Building the Kod for ${kodNames}…`);
  try {
    notify(describeKodLoad(await host.loadKod(result.rooms.map((r) => r.rid))));
  } catch (e) {
    notify(`${kodNames} is saved but not loaded: ${(e as Error).message}`, "error");
  }
}

export function describeInstall(r: InstallResult): string {
  const rebuilt = r.rooms.filter((x) => x.recreated).map((x) => x.rid);
  if (r.serverError) return `Installed ${r.roo}, but the server wasn't told: ${r.serverError}`;
  if (!r.rooms.length) return `Installed ${r.roo}; no room class uses it yet, so the server has nothing to rebuild (${r.ms} ms)`;
  if (!rebuilt.length) return `Installed ${r.roo}; none of its rooms (RID ${r.rooms.map((x) => x.rid).join(", ")}) is loaded on the server (${r.ms} ms)`;
  return `Installed ${r.roo} and rebuilt RID ${rebuilt.join(", ")} on the server (${r.ms} ms)`;
}

export function describeKodLoad(r: KodLoadResult): string {
  const again = r.rooms.filter((x) => x.reloaded).map((x) => x.rid);
  const secs = Math.round(r.ms / 1000);
  if (!again.length) return `Built and reloaded the Kod (${secs} s); none of the room's RIDs is loaded on the server, so it takes the new exits when it's made`;
  return `Built and reloaded the Kod, and RID ${again.join(", ")} made its exits again (${secs} s)`;
}
