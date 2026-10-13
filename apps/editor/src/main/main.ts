// Electron main process: one window, the native menu, and file access for the page.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { MenuCommand } from "./bridge.ts";
import { readKodSources } from "./kod.ts";
import { listRooms } from "./roomsFs.ts";
import { listTextures, readResource, readTexture } from "./textures.ts";

const devUrl = process.env.EDITOR_DEV_URL;
// In development the app path is apps/editor and the working rooms live at the repo
// root (rooms/src for the shipped rooms' sources, rooms/new for new ones), with the
// Shards repo (its Kod) beside it. Installed, there's no repo: rooms default to a folder
// in Documents, and the folders chosen are remembered in settings.json in userData.
const repoRoot = app.isPackaged ? "" : resolve(app.getAppPath(), "../..");
// Development runs keep their own data (and single-instance lock), apart from an installed editor's.
if (!app.isPackaged) app.setPath("userData", join(app.getPath("appData"), "Meridian Room Editor (dev)"));
const settingsPath = join(app.getPath("userData"), "settings.json");
const saved = loadSettings();
let roomsDir = process.env.EDITOR_ROOMS_DIR ?? saved.roomsDir ?? (repoRoot ? join(repoRoot, "rooms") : join(app.getPath("documents"), "Meridian Rooms"));
let exportDir = saved.exportDir ?? (repoRoot ? join(repoRoot, "rooms", "out") : roomsDir);
let win: BrowserWindow | null = null;
let dirty = false;

interface Settings {
  roomsDir?: string;
  exportDir?: string;
}

function loadSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
  } catch {
    return {};
  }
}

function saveSettings(): void {
  try {
    writeFileSync(settingsPath, JSON.stringify({ roomsDir, exportDir }, null, 2));
  } catch {
    // Not worth stopping for: the folders are only defaults.
  }
}

function send(command: MenuCommand): void {
  win?.webContents.send("menu", command);
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  // Items send command ids from the renderer's registry (commands.ts).
  const item = (label: string, command: string, accelerator?: string): MenuItemConstructorOptions => ({ label, accelerator, click: () => send(command) });
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "&File",
      submenu: [
        item("New Room…", "file.new", "CmdOrCtrl+N"),
        item("Open…", "file.open", "CmdOrCtrl+O"),
        item("Open Rooms Folder…", "file.openFolder"),
        { type: "separator" },
        item("Save", "file.save", "CmdOrCtrl+S"),
        item("Save As…", "file.saveAs", "CmdOrCtrl+Shift+S"),
        { type: "separator" },
        item("Compile and Export .roo…", "file.export", "CmdOrCtrl+E"),
        { type: "separator" },
        item("Preferences…", "edit.preferences", "CmdOrCtrl+,"),
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      // Undo, redo and the clipboard are handled by the page, so text fields keep their own.
      label: "&Edit",
      submenu: [
        item("Undo", "edit.undo"),
        item("Redo", "edit.redo"),
        { type: "separator" },
        item("Cut", "edit.cut"),
        item("Copy", "edit.copy"),
        item("Paste", "edit.paste"),
        item("Duplicate", "edit.duplicate"),
        item("Delete", "edit.delete"),
        { type: "separator" },
        item("Select All", "edit.selectAll"),
        item("Rotate and Scale…", "edit.rotateScale"),
        item("Mirror Horizontally", "edit.mirrorH"),
        item("Mirror Vertically", "edit.mirrorV"),
        { type: "separator" },
        item("Command Palette…", "view.palette", "CmdOrCtrl+Shift+P"),
      ],
    },
    {
      label: "&Modes",
      submenu: [item("Things", "mode.thing"), item("Vertices", "mode.vertex"), item("Linedefs", "mode.linedef"), item("Sectors", "mode.sector")],
    },
    {
      label: "&Tools",
      submenu: [
        item("Select", "tool.select"),
        item("Draw Lines", "tool.draw"),
        item("Rectangle", "tool.rectangle"),
        item("Polygon", "tool.polygon"),
        item("Circle", "tool.circle"),
        item("Torch", "tool.torch"),
        item("Thing", "tool.thing"),
        { type: "separator" },
        item("Textures…", "textures.browse"),
      ],
    },
    {
      label: "&Search",
      submenu: [
        item("Find / Change…", "search.find", "CmdOrCtrl+F"),
        item("Jump to Object…", "search.jump", "CmdOrCtrl+J"),
        item("Next Object", "search.next"),
        item("Previous Object", "search.prev"),
      ],
    },
    {
      label: "&Check",
      submenu: [
        item("Statistics", "check.stats"),
        item("Sectors Are Closed", "check.sectors"),
        item("Cross-References", "check.crossrefs"),
        item("Missing Textures", "check.textures"),
        item("Texture Names", "check.textureNames"),
        { type: "separator" },
        item("All Checks", "check.all", "F9"),
      ],
    },
    {
      label: "&View",
      submenu: [
        item("Map", "view.2d", "CmdOrCtrl+1"),
        item("3D Preview", "view.3d", "CmdOrCtrl+2"),
        item("Split", "view.split", "CmdOrCtrl+3"),
        { type: "separator" },
        item("Fit Room", "view.fit"),
        item("Center on Selection", "view.center"),
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc(): void {
  ipcMain.handle("rooms:dir", () => roomsDir);
  ipcMain.handle("rooms:choose-dir", async () => {
    const result = await dialog.showOpenDialog(win!, { title: "Open Rooms Folder", defaultPath: roomsDir, properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    roomsDir = result.filePaths[0];
    saveSettings();
    return roomsDir;
  });
  ipcMain.handle("rooms:list", async () => (await listRooms(roomsDir)).map((r) => ({ id: r.abs, path: r.path, name: r.name })));
  ipcMain.handle("file:read-text", (_e, path: string) => readFile(path, "utf8"));
  ipcMain.handle("file:write-text", (_e, path: string, text: string) => writeFile(path, text, "utf8"));
  ipcMain.handle("file:open", async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: "Open Room",
      defaultPath: roomsDir,
      properties: ["openFile"],
      filters: [
        { name: "Rooms", extensions: ["json", "roo"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    return { path, name: basename(path), bytes: new Uint8Array(await readFile(path)) };
  });
  ipcMain.handle("file:save-text-as", async (_e, name: string, text: string) => {
    const result = await dialog.showSaveDialog(win!, {
      title: "Save Room Source",
      defaultPath: join(roomsDir, name),
      filters: [{ name: "Room source", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, text, "utf8");
    return result.filePath;
  });
  ipcMain.handle("file:export-bytes", async (_e, name: string, bytes: Uint8Array) => {
    const result = await dialog.showSaveDialog(win!, {
      title: "Export Compiled Room",
      defaultPath: join(exportDir, name),
      filters: [{ name: "Meridian room", extensions: ["roo"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, bytes);
    exportDir = dirname(result.filePath);
    saveSettings();
    return result.filePath;
  });
  ipcMain.handle("kod:read", (_e, dir: string) => readKodSources(dir, repoRoot));
  ipcMain.handle("textures:list", (_e, dir: string) => listTextures(dir));
  ipcMain.handle("textures:read", (_e, dir: string, name: string) => readTexture(dir, name));
  ipcMain.handle("textures:read-resource", (_e, dir: string, name: string) => readResource(dir, name));
  ipcMain.handle("dialog:choose-folder", async (_e, title: string, defaultPath: string) => {
    const result = await dialog.showOpenDialog(win!, { title, defaultPath: defaultPath || undefined, properties: ["openDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.on("file:ready", () => {
    pageReady = true;
    for (const f of waiting.splice(0)) void openPath(f);
  });
  ipcMain.on("window:title", (_e, title: string) => win?.setTitle(title));
  ipcMain.on("window:dirty", (_e, value: boolean) => {
    dirty = value;
    win?.setDocumentEdited(value);
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#16181d",
    title: "Meridian Room Editor",
    // The window and taskbar icon on Windows and Linux (the installers carry their own).
    icon: join(__dirname, "../build/icon.png"),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.on("close", (e) => {
    if (!dirty) return;
    const choice = dialog.showMessageBoxSync(win!, {
      type: "warning",
      buttons: ["Discard Changes", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "The room has unsaved changes.",
      detail: "Close anyway and lose them?",
    });
    if (choice === 1) e.preventDefault();
  });
  win.on("closed", () => {
    win = null;
    pageReady = false;
  });

  // Links open in the user's browser, never inside the editor.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, "../dist/renderer/index.html"));
}

// Files the system asks us to open: on the command line (Windows and Linux "Open
// with", a drop on the icon), from a second launch while we're running (forwarded
// by the single-instance lock), or macOS's open-file event. They wait until the
// page says it's listening.
const OPENABLE = /\.(json|roo)$/i;
const waiting: string[] = [];
let pageReady = false;

function filesIn(argv: readonly string[]): string[] {
  // Packaged, argv[0] is the app; in development it's electron, then the app's path.
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith("-") && OPENABLE.test(a) && existsSync(a));
}

async function openPath(path: string): Promise<void> {
  if (!win || !pageReady) {
    waiting.push(path);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.focus();
  try {
    win.webContents.send("file:opened", { path, name: basename(path), bytes: new Uint8Array(await readFile(path)) });
  } catch (e) {
    dialog.showErrorBox("Couldn't open the file", `${path}\n${(e as Error).message}`);
  }
}

// One editor at a time: a second launch hands its files to this one and leaves.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", (_e, argv) => {
  for (const f of filesIn(argv)) void openPath(f);
  if (win?.isMinimized()) win.restore();
  win?.focus();
});
app.on("open-file", (e, path) => {
  e.preventDefault();
  void openPath(path);
});
waiting.push(...filesIn(process.argv));

void app.whenReady().then(() => {
  // The first run of an installed editor: somewhere to keep rooms.
  if (!existsSync(roomsDir)) {
    try {
      mkdirSync(roomsDir, { recursive: true });
    } catch {
      // The folder picker still works.
    }
  }
  buildMenu();
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
