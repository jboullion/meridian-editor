// Updates from GitHub releases (electron-builder.yml publish), after the Shards desktop
// app's setupUpdates. Installed builds only: the installer records the feed in
// resources/app-update.yml, which unpacked test builds and development runs don't have.
//
// Windows and the Linux AppImage download an update in the background and install it on
// quit, or at once from Help → Restart to Update. macOS can't install updates into an
// unsigned app, and a deb is the package manager's, so there the editor only says a new
// version is out and links to its release page.

import { app, dialog, shell, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { UpdateState } from "./bridge.ts";

export const RELEASES = "https://github.com/jboullion/meridian-editor/releases";

interface UpdatesOptions {
  window(): BrowserWindow | null;
  /** The room has unsaved changes: restarting asks first. */
  dirty(): boolean;
  /** Restarting was confirmed: the window's close handler mustn't ask again. */
  discardChanges(): void;
}

let options: UpdatesOptions | null = null;
let state: UpdateState = { state: "idle" };
/** Downloads and installs itself (Windows, AppImage); elsewhere, links to the release. */
const installs = process.platform === "win32" || (process.platform === "linux" && !!process.env.APPIMAGE);

function active(): boolean {
  return app.isPackaged && existsSync(join(process.resourcesPath, "app-update.yml"));
}

function set(next: UpdateState): void {
  state = next;
  options?.window()?.webContents.send("update:state", state);
}

const releasePage = (version: string): string => `${RELEASES}/tag/v${version}`;

export function setupUpdates(opts: UpdatesOptions): void {
  options = opts;
  if (!active()) return;
  const { autoUpdater } = electronUpdater;
  // First lines only: electron-updater's errors carry whole HTTP responses
  const line = (m: unknown): void => console.log(`update: ${String(m).split("\n")[0]}`);
  autoUpdater.logger = { info: line, warn: line, error: () => {}, debug: () => {} };
  autoUpdater.autoDownload = installs;
  autoUpdater.on("update-available", (info) =>
    set(installs ? { state: "downloading", version: info.version } : { state: "available", version: info.version, url: releasePage(info.version) }),
  );
  autoUpdater.on("update-not-available", () => set({ state: "current", version: app.getVersion() }));
  autoUpdater.on("update-downloaded", (info) => set({ state: "ready", version: info.version }));
  autoUpdater.on("error", (e) => {
    line(`failed: ${String(e)}`);
    set({ state: "error", message: String(e).split(/\r?\n/)[0] ?? "" });
  });
  void check();
}

/** The page's own copy, for one that loaded (or reloaded) after the state last changed. */
export function updateState(): UpdateState {
  return state;
}

async function check(): Promise<void> {
  if (state.state === "downloading" || state.state === "ready") return;
  set({ state: "checking" });
  await electronUpdater.autoUpdater.checkForUpdates().catch(() => {
    // The error event has it.
  });
}

/** Help → Check for Updates: checks, then says what it found. */
export async function checkForUpdates(): Promise<void> {
  const win = options?.window() ?? null;
  const show = (message: string, detail?: string, buttons = ["OK"]): Promise<number> =>
    (win ? dialog.showMessageBox(win, { message, detail, buttons }) : dialog.showMessageBox({ message, detail, buttons })).then((r) => r.response);
  if (!active()) {
    if ((await show("Updates only work in an installed editor.", `This is version ${app.getVersion()}. Releases are at ${RELEASES}.`, ["OK", "Open Releases"])) === 1) void shell.openExternal(RELEASES);
    return;
  }
  await check();
  const s = state;
  if (s.state === "current") await show(`Meridian Room Editor ${app.getVersion()} is the latest version.`);
  else if (s.state === "downloading") await show(`Downloading version ${s.version}.`, "It installs when you quit the editor, or use Help → Restart to Update once it's ready.");
  else if (s.state === "ready") {
    if ((await show(`Version ${s.version} is ready to install.`, undefined, ["Restart to Update", "Later"])) === 0) installUpdate();
  } else if (s.state === "available") {
    if ((await show(`Version ${s.version} is out.`, `This is version ${app.getVersion()}. Download the new one from its release page.`, ["Open Release Page", "Later"])) === 0) void shell.openExternal(s.url);
  } else if (s.state === "error") await show("Couldn't check for updates.", s.message);
}

/** Help → Restart to Update. */
export function installUpdate(): void {
  const win = options?.window() ?? null;
  if (state.state === "available") {
    void shell.openExternal(state.url);
    return;
  }
  if (state.state !== "ready") {
    void checkForUpdates();
    return;
  }
  if (options?.dirty() && win) {
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Discard Changes and Restart", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "The room has unsaved changes.",
      detail: "Restart to update anyway and lose them?",
    });
    if (choice === 1) return;
  }
  options?.discardChanges();
  electronUpdater.autoUpdater.quitAndInstall();
}

/** Help → About. */
export function showAbout(): void {
  const win = options?.window() ?? null;
  const o = {
    message: `Meridian Room Editor ${app.getVersion()}`,
    detail: `Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, Node ${process.versions.node}.\nLicensed under the GPL, version 2.\n${RELEASES}`,
    buttons: ["OK", "Open Releases"],
  };
  void (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o)).then((r) => {
    if (r.response === 1) void shell.openExternal(RELEASES);
  });
}
