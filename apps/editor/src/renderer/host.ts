// Where files come from: the Electron bridge (window.editorHost) when running
// in the app, or the Vite dev server's /api/rooms plus downloads in a browser.

import type { AgentCall, AgentReply } from "../main/agentProtocol.ts";
import type { EditorBridge, MenuCommand } from "../main/bridge.ts";
import type { InstallResult, KodLoadResult } from "../main/shardsInstall.ts";

export type { InstallResult, KodLoadResult };

export type { MenuCommand };

export interface RoomEntry {
  /** Pass back to readRoom / writeRoom. */
  id: string;
  /** Relative to the rooms folder. */
  path: string;
  name: string;
}

export interface OpenedFile {
  /** Where to save back to, if the host can write it; null means "Save As" only. */
  id: string | null;
  name: string;
  bytes: Uint8Array;
}

export interface Host {
  kind: "electron" | "browser";
  roomsDir(): Promise<string>;
  /** Null if cancelled or unsupported. */
  chooseRoomsDir(): Promise<string | null>;
  listRooms(): Promise<RoomEntry[]>;
  readRoom(id: string): Promise<string>;
  writeRoom(id: string, text: string): Promise<void>;
  openFile(): Promise<OpenedFile | null>;
  saveRoomAs(suggestedName: string, text: string): Promise<{ id: string; name: string } | null>;
  exportRoo(suggestedName: string, bytes: Uint8Array): Promise<string | null>;
  /** grdNNNNN.bgf textures in `dir` ("" for the default folder). */
  listTextures(dir: string): Promise<{ dir: string; textures: { number: number; name: string }[] }>;
  /** Read one texture file from the folder last listed. */
  readTexture(name: string): Promise<Uint8Array>;
  /** Read any .bgf (an object's sprite) from the same folder. */
  readResource(name: string): Promise<Uint8Array>;
  /** The room classes' Kod source from `dir` ("" for the Shards server's copy beside this repo). */
  readKod(dir: string): Promise<KodSources>;
  /** Save a room class the editor changed: `path` as readKod listed it, in the folder it gave as `dir`; refused if the file no longer has `base`. */
  writeKod(dir: string, path: string, text: string, base: string): Promise<void>;
  /** Puts a saved room in the game on the local Shards stack; null if it isn't one of Shards' rooms. */
  installRoom(id: string, text: string): Promise<InstallResult | null>;
  /** Builds and reloads Shards' Kod ("reload system" saves the game), then has the rooms `rids` make their exits again. */
  loadKod(rids: number[]): Promise<KodLoadResult>;
  /** Null if cancelled or unsupported. */
  chooseFolder(title: string, defaultPath: string): Promise<string | null>;
  setTitle(title: string): void;
  setDirty(dirty: boolean): void;
  onMenu(fn: (command: MenuCommand) => void): () => void;
  /** Files the system asks the editor to open; the host holds them until this is set. */
  onOpenFile(fn: (file: OpenedFile) => void): () => void;
  /** Calls from an agent (packages/agent), through the main process or the dev server. */
  onAgentCall(fn: (call: AgentCall) => Promise<AgentReply>): () => void;
}

let texturesDir = "";

export interface KodSources {
  dir: string;
  /** The room classes. */
  files: { path: string; text: string }[];
  /** Object classes that give light (candles, braziers, lamps, ornaments). */
  objectFiles: { path: string; text: string }[];
  khd: string;
}

declare global {
  interface Window {
    editorHost?: EditorBridge;
  }
}

function electronHost(bridge: EditorBridge): Host {
  return {
    kind: "electron",
    roomsDir: () => bridge.roomsDir(),
    chooseRoomsDir: () => bridge.chooseRoomsDir(),
    listRooms: () => bridge.listRooms(),
    readRoom: (id) => bridge.readText(id),
    writeRoom: (id, text) => bridge.writeText(id, text),
    openFile: async () => {
      const f = await bridge.openFile();
      if (!f) return null;
      return { id: f.name.toLowerCase().endsWith(".json") ? f.path : null, name: f.name, bytes: f.bytes };
    },
    saveRoomAs: async (name, text) => {
      const path = await bridge.saveTextAs(name, text);
      return path ? { id: path, name: baseName(path) } : null;
    },
    exportRoo: (name, bytes) => bridge.exportBytes(name, bytes),
    listTextures: async (dir) => {
      const out = await bridge.listTextures(dir);
      texturesDir = out.dir;
      return out;
    },
    readTexture: (name) => bridge.readTexture(texturesDir, name),
    readResource: (name) => bridge.readResource(texturesDir, name),
    readKod: (dir) => bridge.readKod(dir),
    writeKod: (dir, path, text, base) => bridge.writeKod(dir, path, text, base),
    installRoom: (id, text) => bridge.installRoom(id, text),
    loadKod: (rids) => bridge.loadKod(rids),
    chooseFolder: (title, defaultPath) => bridge.chooseFolder(title, defaultPath),
    setTitle: (title) => bridge.setTitle(title),
    setDirty: (dirty) => bridge.setDirty(dirty),
    onMenu: (fn) => bridge.onMenu(fn),
    onOpenFile: (fn) => {
      const off = bridge.onOpenFile((f) => fn({ id: f.name.toLowerCase().endsWith(".json") ? f.path : null, name: f.name, bytes: f.bytes }));
      bridge.readyForFiles();
      return off;
    },
    onAgentCall: (fn) => bridge.onAgentCall(fn),
  };
}

function browserHost(): Host {
  let dir = "";
  return {
    kind: "browser",
    roomsDir: async () => dir,
    chooseRoomsDir: async () => null,
    listRooms: async () => {
      const res = await fetch("./api/rooms");
      if (!res.ok) return [];
      const data = (await res.json()) as { dir: string; rooms: RoomEntry[] };
      dir = data.dir;
      return data.rooms;
    },
    readRoom: async (id) => {
      const res = await fetch(`./api/rooms/file?path=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(await res.text());
      return res.text();
    },
    writeRoom: async (id, text) => {
      const res = await fetch(`./api/rooms/file?path=${encodeURIComponent(id)}`, { method: "PUT", body: text });
      if (!res.ok) throw new Error(await res.text());
    },
    openFile: () =>
      new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,.roo";
        input.onchange = async () => {
          const file = input.files?.[0];
          resolve(file ? { id: null, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
        };
        input.oncancel = () => resolve(null);
        input.click();
      }),
    saveRoomAs: async (name, text) => {
      download(name, new Blob([text], { type: "application/json" }));
      return null;
    },
    exportRoo: async (name, bytes) => {
      download(name, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
      return name;
    },
    listTextures: async (dir) => {
      const res = await fetch(`./api/textures?dir=${encodeURIComponent(dir)}`);
      const out = res.ok ? ((await res.json()) as { dir: string; textures: { number: number; name: string }[] }) : { dir: "", textures: [] };
      texturesDir = out.dir;
      return out;
    },
    readResource: async (name) => {
      const res = await fetch(`./api/textures/resource?dir=${encodeURIComponent(texturesDir)}&name=${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(await res.text());
      return new Uint8Array(await res.arrayBuffer());
    },
    readTexture: async (name) => {
      const res = await fetch(`./api/textures/file?dir=${encodeURIComponent(texturesDir)}&name=${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(await res.text());
      return new Uint8Array(await res.arrayBuffer());
    },
    readKod: async (dir) => {
      const res = await fetch(`./api/kod?dir=${encodeURIComponent(dir)}`);
      return res.ok ? ((await res.json()) as KodSources) : { dir: "", files: [], objectFiles: [], khd: "" };
    },
    writeKod: async (dir, path, text, base) => {
      const res = await fetch(`./api/kod/file?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(path)}`, { method: "PUT", body: JSON.stringify({ text, base }) });
      if (!res.ok) throw new Error(await res.text());
    },
    installRoom: async (id, text) => {
      const res = await fetch(`./api/shards/install?path=${encodeURIComponent(id)}`, { method: "POST", body: text });
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as InstallResult | null;
    },
    loadKod: async (rids) => {
      const res = await fetch("./api/shards/load-kod", { method: "POST", body: JSON.stringify({ rids }) });
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as KodLoadResult;
    },
    chooseFolder: async (title, defaultPath) => window.prompt(`${title} (a folder path on this machine)`, defaultPath) || null,
    setTitle: (title) => {
      document.title = title;
    },
    setDirty: () => {},
    onMenu: () => () => {},
    onOpenFile: () => () => {},
    onAgentCall: (fn) => {
      // The dev server relays agents' calls over its HMR socket (scripts/agentApi.ts).
      const hot = import.meta.hot;
      if (!hot) return () => {};
      const listener = (data: { id: number; call: AgentCall }): void => {
        void fn(data.call).then((reply) => hot.send("meridian:agent-reply", { id: data.id, reply }));
      };
      hot.on("meridian:agent", listener);
      return () => hot.off("meridian:agent", listener);
    },
  };
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export const host: Host = window.editorHost ? electronHost(window.editorHost) : browserHost();
