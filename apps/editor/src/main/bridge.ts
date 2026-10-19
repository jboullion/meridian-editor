// The API the preload exposes to the page as window.editorHost. Types only, so
// both the sandboxed preload and the renderer can import it.

import type { AgentCall, AgentReply } from "./agentProtocol.ts";
import type { InstallResult, KodLoadResult } from "./shardsInstall.ts";

export interface OpenedFile {
  /** Absolute path. */
  path: string;
  name: string;
  bytes: Uint8Array;
}

/** A command id from the renderer's command registry (commands.ts), sent by the native menu. */
export type MenuCommand = string;

export interface EditorBridge {
  platform: string;
  roomsDir(): Promise<string>;
  chooseRoomsDir(): Promise<string | null>;
  listRooms(): Promise<{ id: string; path: string; name: string }[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  openFile(): Promise<OpenedFile | null>;
  saveTextAs(suggestedName: string, text: string): Promise<string | null>;
  exportBytes(suggestedName: string, bytes: Uint8Array): Promise<string | null>;
  listTextures(dir: string): Promise<{ dir: string; textures: { number: number; name: string }[] }>;
  readTexture(dir: string, name: string): Promise<Uint8Array>;
  /** Any .bgf in the texture folder (object sprites). */
  readResource(dir: string, name: string): Promise<Uint8Array>;
  /** The room classes' Kod source and blakston.khd from `dir` ("" for the default). */
  readKod(dir: string): Promise<{ dir: string; files: { path: string; text: string }[]; objectFiles: { path: string; text: string }[]; khd: string }>;
  /** Save a room class the editor changed, by its path in the Kod folder `dir`, if it still has `base` (kod.ts writeKodFile). */
  writeKod(dir: string, path: string, text: string, base: string): Promise<void>;
  chooseFolder(title: string, defaultPath: string): Promise<string | null>;
  setTitle(title: string): void;
  setDirty(dirty: boolean): void;
  onMenu(fn: (command: MenuCommand) => void): () => void;
  /** Files the system asks the editor to open (Open with, a double-click, a drop on its icon). */
  onOpenFile(fn: (file: OpenedFile) => void): () => void;
  /** The page is ready for files: the main process sends any it's holding. */
  readyForFiles(): void;
  /** Puts a saved Shards room in the game (shardsInstall.ts); null if `path` isn't one of Shards' rooms. */
  installRoom(path: string, text: string): Promise<InstallResult | null>;
  /** Builds and reloads Shards' Kod, then has the rooms `rids` make their exits again (shardsInstall.ts loadKod). */
  loadKod(rids: number[]): Promise<KodLoadResult>;
  /** Calls from an agent (agentEndpoint.ts), answered by the page. */
  onAgentCall(fn: (call: AgentCall) => Promise<AgentReply>): () => void;
}
