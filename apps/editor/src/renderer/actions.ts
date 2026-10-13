// Opening, saving and exporting rooms.

import { readRoo } from "@meridian-editor/roo";
import { formatRoomSource, importRoo, parseRoomSource, validateSource, type RoomSource } from "@meridian-editor/roomc";
import { compileOnce } from "./compiler.ts";
import { promptForm } from "./dialogs.tsx";
import { newRoom, newRoomWithFloor } from "./ops/edit.ts";
import { host, type RoomEntry, type OpenedFile } from "./host.ts";
import { editor, isDirty, loadRoom, notify } from "./store.ts";

const ROOM_SUFFIX = /\.room\.json$|\.json$/i;

export function confirmDiscard(): boolean {
  return !isDirty(editor.get()) || window.confirm("The room has unsaved changes. Discard them?");
}

export async function openEntry(entry: RoomEntry): Promise<void> {
  if (!confirmDiscard()) return;
  try {
    const room = parseChecked(await host.readRoom(entry.id));
    loadRoom({ id: entry.id, name: entry.name }, room);
    notify(`Opened ${entry.path}`);
  } catch (e) {
    notify(`Couldn't open ${entry.path}: ${(e as Error).message}`, "error");
  }
}

export async function openFile(): Promise<void> {
  if (!confirmDiscard()) return;
  const file = await host.openFile();
  if (file) loadOpened(file);
}

/** A file the system handed the editor (Open with, a double-click, a drop on its icon). */
export function openFromSystem(file: OpenedFile): void {
  if (!confirmDiscard()) return;
  loadOpened(file);
}

/** Load an opened room source, or import a .roo. */
function loadOpened(file: OpenedFile): void {
  try {
    if (file.name.toLowerCase().endsWith(".roo")) {
      const room = importRoo(readRoo(file.bytes));
      const name = file.name.replace(/\.roo$/i, "");
      // An imported .roo has no source file yet: Save will ask where to put it.
      loadRoom({ id: null, name }, room, null);
      notify(`Imported ${file.name}; save it to create ${name}.room.json`);
    } else {
      const room = parseChecked(new TextDecoder().decode(file.bytes));
      loadRoom({ id: file.id, name: file.name.replace(ROOM_SUFFIX, "") }, room);
      notify(`Opened ${file.name}`);
    }
  } catch (e) {
    notify(`Couldn't open ${file.name}: ${(e as Error).message}`, "error");
  }
}

export async function save(as = false): Promise<boolean> {
  const { room, doc } = editor.get();
  if (!room || !doc) return false;
  const text = formatRoomSource(room);
  try {
    if (doc.id && !as) {
      await host.writeRoom(doc.id, text);
      editor.set({ saved: room });
      notify(`Saved ${doc.name}`);
      return true;
    }
    const where = await host.saveRoomAs(`${doc.name}.room.json`, text);
    if (where) {
      editor.set({ doc: { id: where.id, name: where.name.replace(ROOM_SUFFIX, "") }, saved: room });
      notify(`Saved ${where.name}`);
      return true;
    }
    if (host.kind === "browser") {
      editor.set({ saved: room });
      notify(`Downloaded ${doc.name}.room.json`);
      return true;
    }
  } catch (e) {
    notify(`Couldn't save: ${(e as Error).message}`, "error");
  }
  return false;
}

export async function exportRoo(): Promise<void> {
  const { room, doc, target } = editor.get();
  if (!room || !doc) return;
  const reply = await compileOnce(room, target);
  if (!reply.ok) {
    const first = reply.diagnostics.find((d) => d.severity === "error");
    notify(`Can't compile for ${target}: ${first?.message ?? "unknown error"}`, "error");
    return;
  }
  const path = await host.exportRoo(`${doc.name}.roo`, reply.bytes);
  if (path) notify(`Compiled for ${target} (v${reply.file.version}) → ${path}`);
}

/** roomedit's "Create level": a room box, optionally with a floor sector filling it. */
export async function newRoomDialog(): Promise<void> {
  if (!confirmDiscard()) return;
  const v = await promptForm(
    "New room",
    [
      { key: "name", label: "Name", type: "text" },
      { key: "width", label: "Width (squares)", type: "number", min: 1, max: 256 },
      { key: "height", label: "Height (squares)", type: "number", min: 1, max: 256 },
      { key: "floor", label: "Start with one sector filling the room", type: "checkbox" },
    ],
    { name: "newroom", width: 16, height: 16, floor: true },
    "Create",
    "The two room-box corners set the room's size and its Kod row/col origin. One grid square is 64 editor units.",
  );
  if (!v) return;
  const w = Math.max(1, Math.trunc(Number(v.width)));
  const h = Math.max(1, Math.trunc(Number(v.height)));
  const room = v.floor ? newRoomWithFloor(w, h, editor.get().prefs.defaults) : newRoom(w, h);
  loadRoom({ id: null, name: String(v.name || "newroom") }, room, null);
  notify(`New ${w}×${h} room. Draw with D (lines), R (rectangle) or the shape tools.`);
}

function parseChecked(text: string): RoomSource {
  const room = parseRoomSource(text);
  const errors = validateSource(room).filter((d) => d.severity === "error");
  if (room.format !== "meridian-room") throw new Error("not a room source");
  if (errors.length) throw new Error(errors[0]!.message);
  return room;
}
