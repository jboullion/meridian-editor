// The room's Kod: what its class places where (exits, generators, objects,
// sounds, the arrival square) and its light; and, for new rooms only, writing
// their own class in rooms/new/<room>.kod. The server's Kod is read-only.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { objectLight } from "../../../../apps/editor/src/renderer/kod/kodLights.ts";
import { exitSpec, removeExit, setExit, type ExitSpec } from "../../../../apps/editor/src/renderer/kod/kodEdit.ts";
import { kodRoomLight, kodToEditor, parseKodRoom, roomBox, type KodExit, type KodRoom } from "../../../../apps/editor/src/renderer/kod/kodRooms.ts";
import { gameLight } from "../../../../apps/editor/src/renderer/preview/gameLight.ts";
import { addToMessage, changedLines, newRoomKodText, setVariable } from "../kodWrite.ts";
import { NEW_KOD, OpError, type Session } from "../session.ts";
import { tool } from "../tool.ts";

const square = z.string().regex(/^\d+\s*,\s*\d+$/).describe('A Kod square "row,col", 1-based from the room box\'s top-left');
const kodExpr = z.string().regex(/^[^\r\n;]+$/).describe("A Kod expression: a number, a constant (LIGHT_NICE), or a resource name");

function parseSquare(s: string): [number, number] {
  const [r, c] = s.split(",").map((n) => Number(n.trim()));
  return [r!, c!];
}

async function current(s: Session): Promise<KodRoom> {
  const k = await s.kodRoom();
  if (!k.room) throw new OpError(k.error ?? "No Kod class for this room.");
  return k.room;
}

function describe(s: Session, k: KodRoom, index: Awaited<ReturnType<Session["kod"]>>["index"]): Record<string, unknown> {
  const room = s.room();
  const box = roomBox(room.things);
  const at = (p: { row: number; col: number; fineRow: number; fineCol: number }) => ({ square: `${p.row},${p.col}`, ...(box ? { editor: kodToEditor(box, p) } : {}) });
  return {
    className: k.className,
    parent: k.parent,
    file: k.path.startsWith(NEW_KOD) ? `rooms/new/${k.path.slice(NEW_KOD.length)} (this room's own Kod; writable with the kod_ tools)` : `${k.path} (the server's Kod; read-only)`,
    roo: k.roo,
    rid: k.ridName,
    arrival: k.teleport && at(k.teleport),
    exits: k.exits.map((e) => ({ ...at(e), to: e.dest ?? "locked door", ...(e.destRow !== undefined ? { toSquare: `${e.destRow},${e.destCol}` } : {}), line: e.line })),
    edgeExits: k.edgeExits,
    generators: k.generators.map((g) => ({ ...at(g), line: g.line })),
    objects: k.objects.map((o) => ({ what: o.what, ...(o.args ? { args: o.args } : {}), ...at(o), ...(o.fineRow !== 32 || o.fineCol !== 32 ? { fine: [o.fineRow, o.fineCol] } : {}), line: o.line })),
    sounds: k.sounds.map((o) => ({ sound: o.what, ...at(o), line: o.line })),
    ...(index ? { light: kodRoomLight(index, k) } : {}),
  };
}

/** The open room's own Kod file in rooms/new; it must exist unless `create`. */
function ownKod(s: Session, room?: string): { file: string; name: string } {
  const name = room ?? s.doc()?.name;
  if (!name || !/^\w+$/.test(name)) throw new OpError("Give the room's name (its rooms/new/<name>.kod).");
  return { file: join(s.roomsDir, "new", `${name}.kod`), name };
}

/** The exit on a square of a class's text, and its place in the class's exits (the last listed, which Kod uses). */
function exitAt(s: Session, file: string, text: string, at: string): { index: number; exit: KodExit } {
  const [r, c] = parseSquare(at);
  const exits = parseKodRoom({ path: file, text }, new Map())?.exits ?? [];
  const index = exits.findLastIndex((e) => e.row === r && e.col === c);
  if (index < 0) throw new OpError(`${s.doc()?.name ?? "The room"}'s Kod has no exit on square ${r},${c}.`);
  return { index, exit: exits[index]! };
}

/** Write a new room's Kod, check it still parses, and report the change. */
async function writeKod(s: Session, file: string, before: string, after: string): Promise<Record<string, unknown>> {
  const lib = await s.kod();
  const parsed = parseKodRoom({ path: file, text: after }, lib.index?.rids ?? new Map());
  if (!parsed) throw new OpError("The change would leave a class the editor can't read as a room (no class header, .roo or room number). Nothing was written.");
  await writeFile(file, after, "latin1");
  s.newRoomKodChanged();
  return {
    file,
    changed: changedLines(before, after),
    reads: { className: parsed.className, arrival: parsed.teleport && `${parsed.teleport.row},${parsed.teleport.col}`, exits: parsed.exits.length, objects: parsed.objects.length, generators: parsed.generators.length },
    note: "shards_install puts the room and its Kod on the local server.",
  };
}

const ROTATE = z.enum(["ROTATE_NONE", "ROTATE_90", "ROTATE_180", "ROTATE_270"]);

export const kodTools = [
  tool({
    name: "kod_room",
    title: "The room's Kod",
    description:
      "The Kod class for the open room: what it places and where (as Kod squares and editor points): the arrival square, exits and where they lead, edge exits, monster generators, objects (NewHold and ornament lists) and looping sounds, plus its light settings. New rooms' own Kod (rooms/new/<room>.kod) is used ahead of the server's copy.",
    input: {},
    annotations: { readOnlyHint: true },
    run: async (s) => {
      const k = await s.kodRoom();
      const lib = await s.kod();
      if (!k.room) throw new OpError(k.error ?? "No Kod class for this room.");
      return { ...describe(s, k.room, lib.index), ...(k.candidates.length > 1 ? { otherClasses: k.candidates.filter((c) => c !== k.room).map((c) => c.className) } : {}) };
    },
  }),

  tool({
    name: "kod_pick_class",
    title: "Pick the room's Kod class",
    description: "When several Kod classes use the room's .roo (tos.roo is Tos and DeathRealmTos), pick which one the Kod tools and checks use.",
    input: { className: z.string() },
    run: async (s, { className }) => {
      const k = await s.kodRoom();
      if (!k.candidates.some((c) => c.className === className)) throw new OpError(`${className} doesn't use this room. Candidates: ${k.candidates.map((c) => c.className).join(", ") || "none"}.`);
      s.pickKodClass(className);
      return { picked: className };
    },
  }),

  tool({
    name: "kod_reload",
    title: "Reload Kod",
    description: "Read the Kod again (after it changed outside the tools).",
    input: {},
    run: async (s) => {
      const lib = await s.kod(true);
      return lib.index ? { folder: lib.index.dir, classes: lib.index.classes.size } : { error: lib.error };
    },
  }),

  tool({
    name: "kod_lights",
    title: "The room's light at an hour",
    description:
      "The light the server would send at a game hour: the room's ambient light and sun shading (from its Kod class), and each light-giving object it places (candles, braziers, lamps, ornaments, signs) with its intensity and colour.",
    input: { hour: z.number().int().min(0).max(23) },
    annotations: { readOnlyHint: true },
    run: async (s, { hour }) => {
      const k = await current(s);
      const lib = await s.kod();
      if (!lib.index || !lib.lights) throw new OpError(lib.error ?? "No Kod.");
      const rl = kodRoomLight(lib.index, k);
      const g = gameLight(hour, rl);
      const box = roomBox(s.room().things);
      const lights = k.objects.flatMap((o) => {
        const l = objectLight(lib.lights!, lib.index!.constants, o, hour, rl.outsideFactor);
        return l ? [{ what: o.what, square: `${o.row},${o.col}`, ...(box ? { editor: kodToEditor(box, o) } : {}), intensity: l.intensity, color: `0x${l.color.toString(16)}`, flags: l.flags }] : [];
      });
      return { hour, ambient: g.ambient, sunShading: g.shade, brightness: g.brightness, roomLight: rl, lights };
    },
  }),

  tool({
    name: "kod_new_room",
    title: "Write a new room's Kod class",
    description:
      "Create rooms/new/<name>.kod: a Room class for the open room (like the editor's test room), with its title, room number (the room's roomId), arrival square, light and terrain. Exits and objects go in with kod_add_exit and kod_add_object. Refuses to replace an existing file unless overwrite.",
    input: {
      className: z.string().regex(/^[A-Z]\w*$/).describe("The Kod class name, such as EditorTestRoom"),
      title: z.string().min(1).max(80).describe("The name players see"),
      arrival: square.describe("Where a teleport (and the arrival marker) puts players"),
      baseLight: kodExpr.optional().describe("piBaseLight; default LIGHT_NICE"),
      outsideFactor: z.number().int().min(0).max(10).optional().describe("piOutside_factor, 0 indoors to 10 fully outdoors; default 0"),
      terrain: z.string().regex(/^TERRAIN_\w+$/).optional().describe("Default TERRAIN_CITY"),
      noCombat: z.boolean().optional(),
      overwrite: z.boolean().optional(),
    },
    annotations: { destructiveHint: true },
    run: async (s, a) => {
      const room = s.room();
      const { file, name } = ownKod(s);
      if (!room.roomId) throw new OpError("Give the room a roomId first: set_properties kind room.");
      if (existsSync(file) && !a.overwrite) throw new OpError(`${file} exists: use kod_add_exit, kod_add_object and kod_set to change it, or pass overwrite.`);
      const text = newRoomKodText({
        className: a.className,
        name,
        title: a.title,
        roomId: room.roomId,
        teleport: parseSquare(a.arrival),
        baseLight: a.baseLight ?? "LIGHT_NICE",
        outsideFactor: a.outsideFactor ?? 0,
        terrain: a.terrain ?? "TERRAIN_CITY",
        noCombat: !!a.noCombat,
      });
      return writeKod(s, file, existsSync(file) ? await readFile(file, "latin1") : "", text);
    },
  }),

  tool({
    name: "kod_add_exit",
    title: "Add an exit in Kod",
    description:
      'Add an exit to the open room\'s own Kod (CreateStandardExits): standing on square at leads to room to (an RID constant such as RID_TOS, or a number) at toSquare. ROOM_LOCKED_DOOR as to makes a locked door.',
    input: {
      at: square,
      to: z.string().regex(/^(RID_\w+|ROOM_LOCKED_DOOR|\d+)$/),
      toSquare: square.optional(),
      rotate: ROTATE.optional(),
      comment: z.string().regex(/^[^\r\n]*$/).optional(),
    },
    run: async (s, a) => {
      const { file } = ownKod(s);
      if (!existsSync(file)) throw new OpError(`${file} doesn't exist: kod_new_room first.`);
      const [r, c] = parseSquare(a.at);
      let fields: string;
      if (a.to === "ROOM_LOCKED_DOOR") fields = `${r}, ${c}, ROOM_LOCKED_DOOR`;
      else {
        if (!a.toSquare) throw new OpError("Give toSquare, where the exit puts players in the other room.");
        const [dr, dc] = parseSquare(a.toSquare);
        fields = `${r}, ${c}, ${a.to}, ${dr}, ${dc}, ${a.rotate ?? "ROTATE_NONE"}`;
      }
      const before = await readFile(file, "latin1");
      const lines = [...(a.comment ? [`// ${a.comment}`] : []), `plExits = Cons([ ${fields} ],plExits);`];
      return writeKod(s, file, before, addToMessage(before, "CreateStandardExits", lines, ["plExits = $;"]));
    },
  }),

  tool({
    name: "kod_set_exit",
    title: "Change an exit in Kod",
    description:
      "Change the exit or locked door on square at, in the open room's own Kod: to ROOM_LOCKED_DOOR (with an optional message resource) or a room (an RID constant or number) at toSquare; moveTo moves it to another square. Only that plExits line changes.",
    input: {
      at: square,
      to: z.string().regex(/^(RID_\w+|ROOM_LOCKED_DOOR|\d+)$/).optional(),
      toSquare: square.optional(),
      rotate: ROTATE.optional(),
      message: z.string().regex(/^[A-Za-z_]\w*$/).optional().describe("A locked door's message resource"),
      moveTo: square.optional(),
    },
    run: async (s, a) => {
      const { file } = ownKod(s);
      if (!existsSync(file)) throw new OpError(`${file} doesn't exist: kod_new_room first.`);
      const before = await readFile(file, "latin1");
      const { index, exit } = exitAt(s, file, before, a.at);
      const old = exitSpec(exit);
      const [row, col] = a.moveTo ? parseSquare(a.moveTo) : [old.row, old.col];
      let spec: ExitSpec;
      if ((a.to ?? (old.dest === null ? "ROOM_LOCKED_DOOR" : old.dest)) === "ROOM_LOCKED_DOOR") spec = { row, col, dest: null, ...(a.message ? { message: a.message } : old.dest === null && old.message ? { message: old.message } : {}) };
      else {
        const [dr, dc] = a.toSquare ? parseSquare(a.toSquare) : old.dest !== null ? [old.destRow, old.destCol] : [];
        if (dr === undefined || dc === undefined) throw new OpError("Give toSquare, where the exit puts players in the other room.");
        spec = { row, col, dest: a.to ?? (old.dest as string), destRow: dr, destCol: dc, rotate: a.rotate ?? (old.dest !== null ? old.rotate : undefined) };
      }
      return writeKod(s, file, before, setExit(before, index, spec));
    },
  }),

  tool({
    name: "kod_remove_exit",
    title: "Remove an exit from Kod",
    description: "Remove the exit or locked door on square at from the open room's own Kod (its plExits line).",
    input: { at: square },
    run: async (s, a) => {
      const { file } = ownKod(s);
      if (!existsSync(file)) throw new OpError(`${file} doesn't exist: kod_new_room first.`);
      const before = await readFile(file, "latin1");
      return writeKod(s, file, before, removeExit(before, exitAt(s, file, before, a.at).index));
    },
  }),

  tool({
    name: "kod_add_object",
    title: "Place an object in Kod",
    description:
      "Place an object in the open room's own Kod (CreateStandardObjects, Send(self,@NewHold,...)): a Kod class (Brazier, Candle, DynamicLight, Sign, a monster ...) with optional Create arguments, on a square, with fine offsets 0–63 (default 32, the centre) and a facing (ANGLE_NORTH ...).",
    input: {
      className: z.string().regex(/^\w+$/),
      args: z.string().regex(/^[^\r\n;]*$/).optional().describe('Create arguments, such as "#iColor=LIGHT_FIRE,#iIntensity=30"'),
      at: square,
      fineRow: z.number().int().min(0).max(63).optional(),
      fineCol: z.number().int().min(0).max(63).optional(),
      angle: z.string().regex(/^ANGLE_\w+$/).optional(),
      comment: z.string().regex(/^[^\r\n]*$/).optional(),
    },
    run: async (s, a) => {
      const { file } = ownKod(s);
      if (!existsSync(file)) throw new OpError(`${file} doesn't exist: kod_new_room first.`);
      const [r, c] = parseSquare(a.at);
      const what = `Create(&${a.className}${a.args ? `,${a.args}` : ""})`;
      const where = `#new_row=${r},#new_col=${c}${a.fineRow !== undefined ? `,#fine_row=${a.fineRow}` : ""}${a.fineCol !== undefined ? `,#fine_col=${a.fineCol}` : ""}${a.angle ? `,#new_angle=${a.angle}` : ""}`;
      const before = await readFile(file, "latin1");
      const lines = [...(a.comment ? [`// ${a.comment}`] : []), `Send(self,@NewHold,#what=${what},${where});`];
      return writeKod(s, file, before, addToMessage(before, "CreateStandardObjects", lines));
    },
  }),

  tool({
    name: "kod_set",
    title: "Set a Kod class variable or property",
    description: "Set name = value in the open room's own Kod, in classvars (viTeleport_row, viTerrain_Type ...) or properties (piBaseLight, piOutside_factor, piRoom_num ...).",
    input: { section: z.enum(["classvars", "properties"]), name: z.string().regex(/^\w+$/), value: kodExpr },
    run: async (s, { section, name, value }) => {
      const { file } = ownKod(s);
      if (!existsSync(file)) throw new OpError(`${file} doesn't exist: kod_new_room first.`);
      const before = await readFile(file, "latin1");
      return writeKod(s, file, before, setVariable(before, section, name, value));
    },
  }),
];
