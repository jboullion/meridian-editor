// window.editorHost. Sandboxed preloads run as CommonJS with only `electron`
// available, so this imports nothing else at run time.

import { contextBridge, ipcRenderer } from "electron";
import type { EditorBridge, MenuCommand, OpenedFile } from "./bridge.ts";

const bridge: EditorBridge = {
  platform: process.platform,
  roomsDir: () => ipcRenderer.invoke("rooms:dir"),
  chooseRoomsDir: () => ipcRenderer.invoke("rooms:choose-dir"),
  listRooms: () => ipcRenderer.invoke("rooms:list"),
  readText: (path) => ipcRenderer.invoke("file:read-text", path),
  writeText: (path, text) => ipcRenderer.invoke("file:write-text", path, text),
  openFile: () => ipcRenderer.invoke("file:open"),
  saveTextAs: (name, text) => ipcRenderer.invoke("file:save-text-as", name, text),
  exportBytes: (name, bytes) => ipcRenderer.invoke("file:export-bytes", name, bytes),
  listTextures: (dir) => ipcRenderer.invoke("textures:list", dir),
  readTexture: (dir, name) => ipcRenderer.invoke("textures:read", dir, name),
  readResource: (dir, name) => ipcRenderer.invoke("textures:read-resource", dir, name),
  readKod: (dir) => ipcRenderer.invoke("kod:read", dir),
  chooseFolder: (title, defaultPath) => ipcRenderer.invoke("dialog:choose-folder", title, defaultPath),
  setTitle: (title) => ipcRenderer.send("window:title", title),
  setDirty: (dirty) => ipcRenderer.send("window:dirty", dirty),
  onOpenFile: (fn) => {
    const listener = (_e: unknown, file: OpenedFile): void => fn(file);
    ipcRenderer.on("file:opened", listener);
    return () => {
      ipcRenderer.off("file:opened", listener);
    };
  },
  readyForFiles: () => ipcRenderer.send("file:ready"),
  onMenu: (fn) => {
    const listener = (_e: unknown, command: MenuCommand): void => fn(command);
    ipcRenderer.on("menu", listener);
    return () => {
      ipcRenderer.off("menu", listener);
    };
  },
};

contextBridge.exposeInMainWorld("editorHost", bridge);
