// Opening, creating, saving and exporting rooms; undo and redo; the target.

import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { newRoom, newRoomWithFloor } from "../../../../apps/editor/src/renderer/ops/edit.ts";
import { runningEndpoints } from "../../../../apps/editor/src/main/agentFiles.ts";
import { OpError, openPath, outDir, roomEntries, type Session } from "../session.ts";
import { compileSummary, tool } from "../tool.ts";

const target = z.enum(["104", "original"]).describe('"104": Server 104 and Shards (ROO v15, exactly two things). "original": the original server (ROO v13, server grids)');

export function status(session: Session): Record<string, unknown> {
  const doc = session.doc();
  const link = session.editor();
  const editor = link ? { connected: link.kind } : { connected: false, running: runningEndpoints().map((e) => e.kind), hint: "connect_editor works in the editor the user has open" };
  const base = { backend: session.backend, editor, roomsDir: session.roomsDir, target: session.target() };
  if (!session.hasRoom()) return { ...base, room: null, hint: "No room is open: list_rooms, then open_room; or new_room." };
  const room = session.room();
  return {
    ...base,
    room: doc?.name,
    file: doc?.path ? relative(session.roomsDir, doc.path).split("\\").join("/") : null,
    dirty: session.dirty(),
    revision: session.revision(),
    roomId: room.roomId,
    counts: { vertices: room.vertices.length, linedefs: room.linedefs.length, sectors: room.sectors.length, things: room.things.length },
    selection: session.selection(),
    undoDepth: session.undoDepth(),
    ...(session.backend === "headless" ? { undo: session.history().slice(-10) } : {}),
    redoDepth: session.redoDepth(),
    compile: compileSummary(session),
  };
}

function needClean(session: Session, discard: boolean | undefined): void {
  if (session.hasRoom() && session.dirty() && !discard) {
    throw new OpError(`${session.doc()?.name ?? "The room"} has unsaved changes: save_room first, or pass discard: true.`);
  }
}

export const documentTools = [
  tool({
    name: "get_status",
    title: "Editor status",
    description: "What's open: the room, its file, unsaved changes, revision, item counts, undo history, target and whether it compiles. Call this first.",
    input: {},
    annotations: { readOnlyHint: true },
    run: (s) => status(s),
  }),

  tool({
    name: "list_rooms",
    title: "List rooms",
    description: "Room sources (*.room.json) in the rooms folder. rooms/src holds the shipped rooms' sources, rooms/new new rooms.",
    input: { filter: z.string().optional().describe("Only paths containing this text (case-insensitive)") },
    annotations: { readOnlyHint: true },
    run: async (s, { filter }) => {
      const all = await roomEntries(s);
      const f = filter?.toLowerCase();
      const rooms = f ? all.filter((r) => r.path.toLowerCase().includes(f)) : all;
      return { roomsDir: s.roomsDir, count: rooms.length, rooms: rooms.slice(0, 500).map((r) => r.path) };
    },
  }),

  tool({
    name: "open_room",
    title: "Open a room",
    description: "Open a .room.json (a path in the rooms folder, such as src/raza.room.json), or import a compiled .roo (any path) as a new unsaved source.",
    input: {
      path: z.string(),
      discard: z.boolean().optional().describe("Throw away unsaved changes to the open room"),
    },
    run: async (s, { path, discard }) => {
      needClean(s, discard);
      const { imported } = await openPath(s, path);
      return { ...(imported ? { imported: true, note: "Imported: save_room with a path to keep it as a source." } : {}), ...status(s) };
    },
  }),

  tool({
    name: "new_room",
    title: "New room",
    description:
      "Create a room (roomedit's Create level): two room-box corner things set its size in 64-unit squares and the Kod row/col origin (top-left is row 1, col 1). With floor (the default), one sector fills the box using the drawing defaults.",
    input: {
      name: z.string().regex(/^\w+$/).describe("Also its .roo name"),
      width: z.number().int().min(1).max(256).describe("Squares, west to east"),
      height: z.number().int().min(1).max(256).describe("Squares, north to south"),
      floor: z.boolean().optional(),
      roomId: z.number().int().min(0).optional().describe("The RID Kod refers to the room by"),
      discard: z.boolean().optional(),
    },
    run: (s, { name, width, height, floor, roomId, discard }) => {
      needClean(s, discard);
      let room = floor === false ? newRoom(width, height) : newRoomWithFloor(width, height, s.prefs().defaults);
      if (roomId) room = { ...room, roomId };
      s.load({ path: null, name }, room, null);
      return { ...status(s), box: { left: 0, top: height * 64, right: width * 64, bottom: 0 }, hint: `save_room with path new/${name}.room.json to keep it.` };
    },
  }),

  tool({
    name: "save_room",
    title: "Save the room",
    description: "Write the room source. Without a path it saves to its own file; a path (relative to the rooms folder) saves it there instead, as Save As does.",
    input: { path: z.string().optional() },
    annotations: { idempotentHint: true },
    run: async (s, { path }) => {
      const abs = await s.save(path);
      return { saved: relative(s.roomsDir, abs).split("\\").join("/"), revision: s.revision() };
    },
  }),

  tool({
    name: "export_roo",
    title: "Compile and export .roo",
    description: "Compile the room and write <name>.roo to rooms/out. .roo files are build output: never commit them.",
    input: { target: target.optional() },
    annotations: { idempotentHint: true },
    run: async (s, { target: t }) => {
      const c = s.compile(t ?? s.target());
      if (!c.ok) throw new OpError(`Can't compile for ${c.target}: ${c.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ")}`);
      const dir = outDir(s);
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${s.doc()!.name}.roo`);
      await writeFile(file, c.bytes);
      return { wrote: file, target: c.target, version: c.file.version, bytes: c.bytes.length, warnings: c.diagnostics.map((d) => d.message) };
    },
  }),

  tool({
    name: "undo",
    title: "Undo",
    description: "Undo the last edit (each tool call is one step; a batch is one step).",
    input: {},
    run: async (s) => {
      const label = await s.undo();
      return { undid: label, revision: s.revision(), undoDepth: s.undoDepth(), redoDepth: s.redoDepth() };
    },
  }),

  tool({
    name: "redo",
    title: "Redo",
    description: "Redo the last undone edit.",
    input: {},
    run: async (s) => {
      const label = await s.redo();
      return { redid: label, revision: s.revision(), undoDepth: s.undoDepth(), redoDepth: s.redoDepth() };
    },
  }),

  tool({
    name: "set_target",
    title: "Compile target",
    description: "Which server the room compiles for. Edits report compile errors for this target.",
    input: { target },
    run: (s, { target: t }) => {
      s.setTarget(t);
      return { target: t, ...(s.hasRoom() ? { compile: compileSummary(s) } : {}) };
    },
  }),
];
