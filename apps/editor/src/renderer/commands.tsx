// Every editor operation as a named command: keyboard shortcuts, the native
// menu, the map's right-click menu and the command palette all run these.
// Grouped roughly as roomedit's menus (Edit, Modes, Misc per mode, Search, Check).

import type { RoomSource } from "@meridian-editor/roomc";
import { exportRoo, newRoomDialog, openFile, save } from "./actions.ts";
import { compiled } from "./compiler.ts";
import { confirmDialog, promptForm, showDialog } from "./dialogs.tsx";
import { kodCoords, roomBounds, roomBoxSize } from "./geometry.ts";
import { baseName, host } from "./host.ts";
import { checkCrossReferences, checkSectors, checkTextureNames, checkTextures, statistics, type CheckIssue } from "./ops/checks.ts";
import { connectVertices, splitLinedefsAndSector } from "./ops/draw.ts";
import {
  addSlope,
  addVertex,
  alignTexturesX,
  alignTexturesY,
  copySelection,
  deleteItems,
  deleteLinedefsJoinSectors,
  deleteVertexJoinLinedefs,
  distributeHeights,
  flipLinedefs,
  freeSectorServerId,
  linkVertices,
  loopFrom,
  makeDoor,
  makeLift,
  makeSectorFromLinedefs,
  mergeSectors,
  mergeVertices,
  mirror,
  paste,
  rotateScale,
  splitLinedefs,
  verticesOf,
  type WallPart,
} from "./ops/edit.ts";
import { OpError } from "./ops/types.ts";
import { browseTextures } from "./textures/TexturePicker.tsx";
import { knownTextures, reloadLibrary, textureWidth } from "./textures/library.ts";
import { checkKodPlacements } from "./kod/kodChecks.ts";
import { addExit, exitSpec, removeExit, setExit, type ExitSpec } from "./kod/kodEdit.ts";
import type { KodExit, KodRoom } from "./kod/kodRooms.ts";
import { currentKodRoom, editRoomKod, kod, reloadKod } from "./kod/kodStore.ts";
import { editorToClient, startWalk, stopWalk, walk } from "./preview/walkStore.ts";
import { installOnSave, setInstallOnSave } from "./shardsInstall.ts";
import {
  count,
  cursor,
  edit,
  editor,
  notify,
  redo,
  requestView,
  savePrefs,
  select,
  selectKodExit,
  selectOne,
  setMode,
  setTool,
  undo,
  type EditorState,
  type ItemKind,
  type Selection,
  type Tool,
} from "./store.ts";

export type Group = "File" | "Edit" | "Mode" | "Tool" | "View" | "Vertices" | "Linedefs" | "Sectors" | "Things" | "Kod" | "Search" | "Check" | "Textures";

export interface Command {
  id: string;
  label: string;
  group: Group;
  /** Shown next to the label. */
  keys?: string;
  /** Matches a keydown (outside text fields). */
  key?: (e: KeyboardEvent) => boolean;
  /** Also works while typing in a field (Ctrl+S and friends). */
  global?: boolean;
  /** Offered in the right-click menu in these modes. */
  modes?: ItemKind[];
  enabled?: (s: EditorState) => boolean;
  run: () => void | Promise<void>;
}

/** A key matcher: "ctrl+shift+z", "delete", "g", "shift+g". */
function k(spec: string): (e: KeyboardEvent) => boolean {
  const parts = spec.toLowerCase().split("+");
  const key = parts.pop()!;
  const ctrl = parts.includes("ctrl");
  const shift = parts.includes("shift");
  const alt = parts.includes("alt");
  // Shift must match exactly, except for symbols that need it to be typed at all.
  const strict = /^[a-z0-9]$/.test(key) || (key.length > 1 && key !== "plus");
  return (e) =>
    (e.ctrlKey || e.metaKey) === ctrl &&
    e.altKey === alt &&
    (shift ? e.shiftKey : strict ? !e.shiftKey : true) &&
    (e.key.toLowerCase() === key || e.code.toLowerCase() === key || (key === "plus" && (e.key === "+" || e.key === "=")));
}

const hasRoom = (s: EditorState): boolean => s.room !== null;
const selected = (kind: ItemKind, min = 1) => (s: EditorState): boolean => s.selection?.kind === kind && s.selection.indices.length >= min;
const anySelection = (s: EditorState): boolean => !!s.selection && s.selection.indices.length > 0;

function need(kind: ItemKind, min = 1, what?: string): number[] | null {
  const s = editor.get().selection;
  if (!s || s.kind !== kind || s.indices.length < min) {
    notify(what ?? `Select ${min > 1 ? `at least ${min} ` : ""}${kind}s first.`, "error");
    return null;
  }
  return s.indices;
}

function run(fn: (room: RoomSource) => RoomSource, done?: string): boolean {
  const ok = edit(fn);
  if (ok && done) notify(done);
  return ok;
}

/** Edit and select what the edit produced. */
function runSelect(fn: (room: RoomSource) => { room: RoomSource; selection: Selection | null }, done?: string): void {
  let selection: Selection | null = null;
  const ok = edit((r) => {
    const out = fn(r);
    selection = out.selection;
    return out.room;
  });
  if (ok) {
    select(selection);
    if (done) notify(done);
  }
}

// ---------------------------------------------------------------- clipboard

function copy(): boolean {
  const { room, selection } = editor.get();
  if (!room || !selection) return false;
  editor.set({ clipboard: copySelection(room, selection.kind, selection.indices) });
  notify(`Copied ${selection.indices.length} ${selection.kind}(s).`);
  return true;
}

function pasteAt(dx?: number, dy?: number): void {
  const { clipboard, grid } = editor.get();
  if (!clipboard) return notify("Nothing to paste.", "error");
  let ox = dx;
  let oy = dy;
  if (ox === undefined || oy === undefined) {
    // Put the copy's top-left at the cursor, on the grid.
    const xs = [...clipboard.vertices.map((v) => v[0]), ...clipboard.things.map((t) => t.x)];
    const ys = [...clipboard.vertices.map((v) => v[1]), ...clipboard.things.map((t) => t.y)];
    const c = cursor.get();
    const at = c.inside ? [c.x, c.y] : [Math.min(...xs) + 64, Math.max(...ys) - 64];
    ox = Math.round((at[0]! - Math.min(...xs)) / grid) * grid;
    oy = Math.round((at[1]! - Math.max(...ys)) / grid) * grid;
  }
  runSelect((r) => {
    const out = paste(r, clipboard, ox, oy);
    return { room: out.room, selection: { kind: out.kind, indices: out.indices } };
  }, "Pasted.");
}

// ---------------------------------------------------------------- view helpers

export function selectionCenter(room: RoomSource, sel: Selection): [number, number] | null {
  let pts: [number, number][];
  if (sel.kind === "thing") pts = sel.indices.map((i) => [room.things[i]!.x, room.things[i]!.y]);
  else pts = verticesOf(room, sel.kind, sel.indices).map((v) => room.vertices[v]!);
  if (pts.length === 0) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

function centerOnSelection(): void {
  const { room, selection } = editor.get();
  if (!room || !selection) return;
  const c = selectionCenter(room, selection);
  if (c) requestView({ kind: "center", x: c[0], y: c[1] });
}

function step(delta: number): void {
  const { room, mode, selection } = editor.get();
  if (!room) return;
  const n = count(room, mode);
  if (n === 0) return;
  const current = selection?.kind === mode ? selection.indices[selection.indices.length - 1]! : delta > 0 ? -1 : 0;
  selectOne({ kind: mode, index: (current + delta + n) % n });
  centerOnSelection();
}

// ---------------------------------------------------------------- checks

export function showIssues(title: string, items: CheckIssue[]): void {
  editor.set({ issues: { title, items } });
  const errors = items.filter((i) => i.severity === "error").length;
  notify(items.length ? `${title}: ${errors} error(s), ${items.length - errors} warning(s).` : `${title}: no problems found.`);
}

function runChecks(which: "sectors" | "crossrefs" | "textures" | "names" | "kod" | "all"): void {
  const room = editor.get().room;
  if (!room) return;
  const items: CheckIssue[] = [];
  if (which === "sectors" || which === "all") items.push(...checkSectors(room));
  if (which === "crossrefs" || which === "all") items.push(...checkCrossReferences(room));
  if (which === "textures" || which === "all") items.push(...checkTextures(room));
  if (which === "names" || which === "all") items.push(...checkTextureNames(room, knownTextures()));
  if (which === "kod" || which === "all") {
    const k = currentKodRoom().room;
    if (k) items.push(...checkKodPlacements(room, k));
    else if (which === "kod") items.push({ severity: "warning", message: kod.get().error ?? "No Kod room class uses this room's .roo file." });
  }
  const titles = { sectors: "Sectors are closed", crossrefs: "Cross-references", textures: "Missing textures", names: "Texture names", kod: "Kod placements", all: "All checks" };
  showIssues(titles[which], items);
}

/** Kod's NewHold arguments for the spot under the cursor, to paste into a room class. */
async function copyKodPosition(): Promise<void> {
  const { room } = editor.get();
  const c = cursor.get();
  const p = room && kodCoords(room, c.x, c.y);
  if (!p) return notify("The room has no room box to count Kod rows and columns from.", "error");
  const text = `#new_row=${p.row},#new_col=${p.col},#fine_row=${p.fineRow},#fine_col=${p.fineCol}`;
  try {
    await navigator.clipboard.writeText(text);
    notify(`Copied ${text}`);
  } catch {
    notify(text);
  }
}

// ---------------------------------------------------------------- dialogs

async function rotateScaleDialog(): Promise<void> {
  const sel = editor.get().selection;
  if (!sel) return notify("Select something to rotate or scale.", "error");
  const v = await promptForm(
    "Rotate and scale",
    [
      { key: "angle", label: "Rotate by (degrees, counter-clockwise)", type: "number", step: 1 },
      { key: "scale", label: "Scale (%)", type: "number", min: 1, step: 1 },
      { key: "snap", label: "Snap vertices to 8 units (as roomedit does)", type: "checkbox" },
    ],
    { angle: 0, scale: 100, snap: true },
    "Apply",
  );
  if (!v) return;
  run((r) => rotateScale(r, sel.kind, sel.indices, Number(v.angle), Number(v.scale) / 100, !!v.snap), "Rotated and scaled.");
}

async function alignXDialog(): Promise<void> {
  const indices = need("linedef", 1, "Select linedefs in order along the wall (or one linedef of a loop).");
  const room = editor.get().room;
  if (!indices || !room) return;
  const v = await promptForm(
    "Align textures (X offset)",
    [
      {
        key: "side",
        label: "Side",
        type: "select",
        options: [
          { value: "front", label: "Front (SD1)" },
          { value: "back", label: "Back (SD2)" },
        ],
      },
      {
        key: "part",
        label: "Texture",
        type: "select",
        options: [
          { value: "normal", label: "Normal" },
          { value: "above", label: "Upper (above)" },
          { value: "below", label: "Lower (below)" },
        ],
      },
      { key: "offset", label: "Initial offset", type: "number", min: 0 },
      { key: "loop", label: "Follow the whole loop from the first linedef (roomedit's 'circle' align)", type: "checkbox" },
    ],
    { side: "front", part: "normal", offset: 0, loop: indices.length === 1 },
    "Align",
    "Offsets run on along the chain and wrap at the texture's width, taken from the texture library.",
  );
  if (!v) return;
  const chain = v.loop ? loopFrom(room, indices[0]!) : indices;
  const front = v.side === "front";
  const part = v.part as WallPart;
  const first = room.linedefs[chain[0]!];
  const tex = first && (front ? first.front : first.back)?.[part];
  const width = tex ? await textureWidth(tex) : null;
  run((r) => alignTexturesX(r, chain, { front, part, initialOffset: Number(v.offset), textureWidth: () => width }), "Aligned x offsets.");
}

async function findDialog(): Promise<void> {
  const room = editor.get().room;
  if (!room) return;
  const v = await promptForm(
    "Find / change",
    [
      {
        key: "what",
        label: "Find",
        type: "select",
        options: [
          { value: "wall", label: "Wall texture (any part)" },
          { value: "normal", label: "Normal texture" },
          { value: "above", label: "Upper texture" },
          { value: "below", label: "Lower texture" },
          { value: "wallId", label: "Wall server id" },
          { value: "floorTexture", label: "Floor texture" },
          { value: "ceilingTexture", label: "Ceiling texture" },
          { value: "serverId", label: "Sector server id" },
          { value: "light", label: "Sector light" },
          { value: "floorHeight", label: "Floor height" },
          { value: "ceilingHeight", label: "Ceiling height" },
        ],
      },
      { key: "value", label: "Value", type: "number" },
      { key: "change", label: "Change matches to this value", type: "checkbox" },
      { key: "replacement", label: "New value", type: "number" },
    ],
    { what: "wall", value: 0, change: false, replacement: 0 },
    "Find",
  );
  if (!v) return;
  const what = String(v.what);
  const value = Number(v.value);
  const rep = Number(v.replacement);
  const sideKeys: Record<string, ("normal" | "above" | "below" | "serverId")[]> = {
    wall: ["normal", "above", "below"],
    normal: ["normal"],
    above: ["above"],
    below: ["below"],
    wallId: ["serverId"],
  };
  if (sideKeys[what]) {
    const keys = sideKeys[what]!;
    const hits = room.linedefs.flatMap((l, i) => ([l.front, l.back].some((s) => s && keys.some((key) => s[key] === value)) ? [i] : []));
    if (v.change && hits.length) {
      run((r) => ({
        ...r,
        linedefs: r.linedefs.map((l) => {
          const fix = (s: typeof l.front) => {
            if (!s) return s;
            const out = { ...s };
            for (const key of keys) if (out[key] === value) out[key] = rep;
            return out;
          };
          return { ...l, front: fix(l.front), back: fix(l.back) };
        }),
      }));
    }
    select({ kind: "linedef", indices: hits });
    notify(`${hits.length} linedef(s) ${v.change ? "changed" : "found"}.`);
  } else {
    const key = what as "floorTexture" | "ceilingTexture" | "serverId" | "light" | "floorHeight" | "ceilingHeight";
    const hits = room.sectors.flatMap((s, i) => (s[key] === value ? [i] : []));
    if (v.change && hits.length) run((r) => ({ ...r, sectors: r.sectors.map((s) => (s[key] === value ? { ...s, [key]: rep } : s)) }));
    select({ kind: "sector", indices: hits });
    notify(`${hits.length} sector(s) ${v.change ? "changed" : "found"}.`);
  }
  if (editor.get().selection) centerOnSelection();
}

async function jumpDialog(): Promise<void> {
  const { room, mode } = editor.get();
  if (!room) return;
  const v = await promptForm("Jump to object", [{ key: "index", label: `${mode} number (0–${count(room, mode) - 1})`, type: "number", min: 0 }], { index: 0 }, "Go");
  if (!v) return;
  const index = Number(v.index);
  if (index < 0 || index >= count(room, mode)) return notify(`There is no ${mode} ${index}.`, "error");
  selectOne({ kind: mode, index });
  centerOnSelection();
}

async function lightingDialog(): Promise<void> {
  const l = editor.get().light;
  const v = await promptForm(
    "Lighting",
    [
      {
        key: "mode",
        label: "Lighting",
        type: "select",
        options: [
          { value: "game", label: "The client's, with the room's Kod light" },
          { value: "flat", label: "Flat: each sector's light level" },
        ],
      },
      { key: "hour", label: "Game hour (0-23): sets the ambient light, the sun's direction and its shading", type: "number", min: 0, max: 23 },
      { key: "playerLight", label: "Player light (0-255; 5 unless a spell or item changes it)", type: "number", min: 0, max: 255 },
      { key: "fog", label: "Fog while walking, as the client draws it", type: "checkbox" },
      { key: "sources", label: "Light from the room's Kod objects (fires, lamps, candles, signs)", type: "checkbox" },
    ],
    { mode: l.mode, hour: l.hour, playerLight: l.playerLight, fog: l.fog, sources: l.sources },
    "Apply",
    "The ambient light comes from the room's Kod class: piBaseLight + piOutside_factor × (brightness − 50) / 4, as room.kod GetRoomLight works it out.",
  );
  if (!v) return;
  const num = (x: unknown, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.trunc(Number(x)) || 0));
  editor.set({ light: { mode: v.mode === "flat" ? "flat" : "game", hour: num(v.hour, 0, 23), playerLight: num(v.playerLight, 0, 255), fog: !!v.fog, sources: !!v.sources } });
}

export async function preferencesDialog(): Promise<void> {
  const p = editor.get().prefs;
  const d = p.defaults;
  const v = await promptForm(
    "Preferences",
    [
      { key: "floorHeight", label: "New sector floor height", type: "number" },
      { key: "ceilingHeight", label: "New sector ceiling height", type: "number" },
      { key: "floorTexture", label: "New sector floor texture", type: "number", min: 0 },
      { key: "ceilingTexture", label: "New sector ceiling texture", type: "number", min: 0 },
      { key: "light", label: "New sector light", type: "number", min: 0, max: 255 },
      { key: "wallTexture", label: "New wall texture (normal)", type: "number", min: 0 },
      { key: "upperTexture", label: "New wall texture (above)", type: "number", min: 0 },
      { key: "lowerTexture", label: "New wall texture (below)", type: "number", min: 0 },
      { key: "passable", label: "Drawn steps and openings can be walked through (WF_PASSABLE; roomedit left it off)", type: "checkbox" },
      { key: "polygonSides", label: "Polygon tool sides", type: "number", min: 3, max: 64 },
      {
        key: "torchAngle",
        label: "Torch faces",
        type: "select",
        options: [
          { value: 0, label: "North" },
          { value: 90, label: "East" },
          { value: 180, label: "South" },
          { value: 270, label: "West" },
        ],
      },
      { key: "pillar", label: "Shapes inside a sector make solid pillars (roomedit) instead of inner sectors", type: "checkbox" },
      { key: "texturesDir", label: "Textures folder (grdNNNNN.bgf); empty for the Shards game files, else the installed client", type: "text" },
      { key: "kodDir", label: "Kod folder (room classes and blakston.khd); empty for the Shards server's", type: "text" },
      { key: "installOnSave", label: "Saving a Shards room puts it in the game: compiled, copied to the server and the game files, and rebuilt on the running server", type: "checkbox" },
    ],
    { ...d, polygonSides: p.polygonSides, torchAngle: p.torchAngle, pillar: p.pillar, texturesDir: p.texturesDir, kodDir: p.kodDir, installOnSave: installOnSave() },
    "Save",
    "roomedit's defaults are no textures, floor 0, ceiling 64 and light 128.",
  );
  if (!v) return;
  const num = (x: unknown): number => Math.trunc(Number(x)) || 0;
  savePrefs({
    defaults: {
      floorHeight: num(v.floorHeight),
      ceilingHeight: num(v.ceilingHeight),
      floorTexture: num(v.floorTexture),
      ceilingTexture: num(v.ceilingTexture),
      light: Math.min(255, Math.max(0, num(v.light))),
      wallTexture: num(v.wallTexture),
      upperTexture: num(v.upperTexture),
      lowerTexture: num(v.lowerTexture),
      passable: !!v.passable,
    },
    polygonSides: Math.max(3, num(v.polygonSides)),
    torchAngle: num(v.torchAngle),
    pillar: !!v.pillar,
    texturesDir: String(v.texturesDir ?? "").trim(),
    kodDir: String(v.kodDir ?? "").trim(),
  });
  if (String(v.texturesDir ?? "").trim() !== p.texturesDir) void reloadLibrary();
  if (String(v.kodDir ?? "").trim() !== p.kodDir) void reloadKod();
  setInstallOnSave(!!v.installOnSave);
}

function statsDialog(): void {
  const room = editor.get().room;
  if (!room) return;
  const file = compiled.get().result?.file;
  const rows = statistics(room);
  // The room box is the room's size as Kod counts it; rooms can draw past it (Raza's forest).
  const box = roomBoxSize(room);
  const b = roomBounds(room);
  const drawn = { width: (b.maxX - b.minX) / 64, height: (b.maxY - b.minY) / 64 };
  void showDialog(
    "Statistics",
    <dl className="stats wide">
      {rows.map((r) => (
        <div key={r.label} style={{ display: "contents" }}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
      {file && (
        <>
          <dt>Compiled ({editor.get().target})</dt>
          <dd>
            v{file.version}: {file.nodes.length} nodes, {file.clientWalls.length} client walls, {file.sidedefs.length} sidedefs
          </dd>
        </>
      )}
      {box && (
        <>
          <dt>Room box</dt>
          <dd>
            {box.width} × {box.height} squares
          </dd>
        </>
      )}
      {(!box || drawn.width !== box.width || drawn.height !== box.height) && (
        <>
          <dt>Drawn area</dt>
          <dd>
            {drawn.width} × {drawn.height} squares{box && ", past the room box"}
          </dd>
        </>
      )}
    </dl>,
  );
}

// ---------------------------------------------------------------- Kod exits

const ALL_MODES: ItemKind[] = ["vertex", "linedef", "sector", "thing"];
const ROTATIONS = ["ROTATE_NONE", "ROTATE_90", "ROTATE_180", "ROTATE_270"];
const kodExitPicked = (s: EditorState): boolean => s.kodExit !== null;

/** The Kod exit picked on the map. */
function pickedExit(): { k: KodRoom; e: KodExit; index: number } | null {
  const index = editor.get().kodExit;
  const k = currentKodRoom().room;
  const e = index === null ? undefined : k?.exits[index];
  if (!k || !e || index === null) {
    notify("Pick a Kod exit on the map first: click its square or its label.", "error");
    return null;
  }
  return { k, e, index };
}

/** Where an exit leads must be a room the Kod knows. */
function checkDest(spec: ExitSpec): void {
  const rids = kod.get().index?.rids;
  if (spec.dest?.startsWith("RID_") && rids && !rids.has(spec.dest)) throw new OpError(`${spec.dest} isn't one of blakston.khd's room numbers.`);
}

export function describeExit(e: ExitSpec): string {
  return e.dest === null ? "a locked door" : `an exit to ${e.dest} (${e.destRow}, ${e.destCol})`;
}

/** Change Kod exit `index` of the open room's class: one undo step, written when the room is saved. */
export function changeKodExit(index: number, spec: ExitSpec): boolean {
  const ok = editRoomKod((text) => {
    checkDest(spec);
    return setExit(text, index, spec);
  });
  if (ok) notify(`Kod row ${spec.row}, col ${spec.col} is now ${describeExit(spec)}. Save to write the Kod.`);
  return ok;
}

async function exitDialog(title: string, initial: ExitSpec, submit: string): Promise<ExitSpec | null> {
  const rotate = initial.dest !== null ? (initial.rotate ?? "ROTATE_NONE") : "ROTATE_NONE";
  const v = await promptForm(
    title,
    [
      {
        key: "kind",
        label: "What it is",
        type: "select",
        options: [
          { value: "locked", label: "Locked door: stops players, with a message" },
          { value: "exit", label: "Exit: takes players to another room" },
        ],
      },
      { key: "row", label: "Kod row", type: "number", min: 1 },
      { key: "col", label: "Kod column", type: "number", min: 1 },
      { key: "message", label: "Locked door's message", type: "text", hint: "A resource name from the class, such as marion_gate_warning; empty for the server's \"the door is locked\"." },
      { key: "dest", label: "Exit to room", type: "text", hint: "An RID_ constant from blakston.khd (RID_MAR_INN) or a room number." },
      { key: "destRow", label: "Arrive at row", type: "number", min: 1 },
      { key: "destCol", label: "Arrive at column", type: "number", min: 1 },
      { key: "rotate", label: "Turn the player", type: "select", options: [...new Set([...ROTATIONS, rotate])].map((r) => ({ value: r, label: r })) },
    ],
    {
      kind: initial.dest === null ? "locked" : "exit",
      row: initial.row,
      col: initial.col,
      message: initial.dest === null ? (initial.message ?? "") : "",
      dest: initial.dest ?? "",
      destRow: initial.dest !== null ? initial.destRow : 1,
      destCol: initial.dest !== null ? initial.destCol : 1,
      rotate,
    },
    submit,
    "Kod rows and columns count from 1 at the room box's top-left. Players step on the square to use it (room.kod SomethingTryGo).",
  );
  if (!v) return null;
  const row = Number(v.row);
  const col = Number(v.col);
  if (v.kind === "locked") {
    const message = String(v.message).trim();
    return { row, col, dest: null, ...(message ? { message } : {}) };
  }
  return { row, col, dest: String(v.dest).trim(), destRow: Number(v.destRow), destCol: Number(v.destCol), rotate: String(v.rotate) };
}

/** Ask for an exit until `apply` takes it (it says why it didn't), or the dialog is cancelled. */
async function exitDialogLoop(title: string, initial: ExitSpec, submit: string, apply: (spec: ExitSpec) => boolean): Promise<void> {
  for (let spec: ExitSpec | null = initial; ; ) {
    spec = await exitDialog(title, spec, submit);
    if (!spec) return;
    editor.set({ message: null });
    if (apply(spec) || editor.get().message?.kind !== "error") return;
  }
}

async function editKodExit(): Promise<void> {
  const p = pickedExit();
  if (!p) return;
  await exitDialogLoop(`Kod exit at row ${p.e.row}, col ${p.e.col}`, exitSpec(p.e), "Change", (spec) => changeKodExit(p.index, spec));
}

function deleteKodExit(): void {
  const p = pickedExit();
  if (!p) return;
  if (editRoomKod((text) => removeExit(text, p.index))) {
    selectKodExit(null);
    notify(`Removed the ${p.e.dest === null ? "locked door" : `exit to ${p.e.dest}`} at Kod row ${p.e.row}, col ${p.e.col}. Save to write ${baseName(p.k.path)}.`);
  }
}

async function addKodExit(): Promise<void> {
  const { room } = editor.get();
  const c = cursor.get();
  const k = currentKodRoom().room;
  if (!room || !k) return notify(kod.get().error ?? "No Kod room class uses this room's .roo file.", "error");
  const at = kodCoords(room, c.x, c.y);
  const index = k.exits.length;
  await exitDialogLoop(`New Kod exit in ${k.className}`, { row: at?.row ?? 1, col: at?.col ?? 1, dest: null }, "Add", (spec) => {
    const ok = editRoomKod((text) => {
      checkDest(spec);
      return addExit(text, spec);
    });
    if (ok) {
      selectKodExit(index);
      notify(`Added ${describeExit(spec)} at Kod row ${spec.row}, col ${spec.col}. Save to write ${baseName(k.path)}.`);
    }
    return ok;
  });
}

// ---------------------------------------------------------------- the registry

const tool =(id: Tool, label: string, keys: string, key: string): Command => ({
  id: `tool.${id}`,
  label,
  group: "Tool",
  keys,
  key: k(key),
  enabled: hasRoom,
  run: () => setTool(id),
});

const mode = (id: ItemKind, label: string, key: string): Command => ({ id: `mode.${id}`, label, group: "Mode", keys: key.toUpperCase(), key: k(key), run: () => setMode(id) });

export const COMMANDS: Command[] = [
  // File
  { id: "file.new", label: "New room…", group: "File", keys: "Ctrl+N", key: k("ctrl+n"), global: true, run: () => newRoomDialog() },
  { id: "file.open", label: "Open…", group: "File", keys: "Ctrl+O", key: k("ctrl+o"), global: true, run: () => openFile() },
  {
    id: "file.openFolder",
    label: "Open rooms folder…",
    group: "File",
    run: () => void host.chooseRoomsDir().then((d) => d && window.dispatchEvent(new Event("rooms-changed"))),
  },
  { id: "file.save", label: "Save", group: "File", keys: "Ctrl+S", key: k("ctrl+s"), global: true, enabled: hasRoom, run: () => void save() },
  { id: "file.saveAs", label: "Save as…", group: "File", keys: "Ctrl+Shift+S", key: k("ctrl+shift+s"), global: true, enabled: hasRoom, run: () => void save(true) },
  { id: "file.export", label: "Compile and export .roo…", group: "File", keys: "Ctrl+E", key: k("ctrl+e"), global: true, enabled: hasRoom, run: () => exportRoo() },

  // Edit
  { id: "edit.undo", label: "Undo", group: "Edit", keys: "Ctrl+Z", key: k("ctrl+z"), run: undo },
  { id: "edit.redo", label: "Redo", group: "Edit", keys: "Ctrl+Y", key: (e) => k("ctrl+y")(e) || k("ctrl+shift+z")(e), run: redo },
  { id: "edit.copy", label: "Copy", group: "Edit", keys: "Ctrl+C", key: k("ctrl+c"), enabled: anySelection, modes: ["vertex", "linedef", "sector", "thing"], run: () => void copy() },
  {
    id: "edit.cut",
    label: "Cut",
    group: "Edit",
    keys: "Ctrl+X",
    key: k("ctrl+x"),
    enabled: anySelection,
    run: () => {
      const sel = editor.get().selection;
      if (sel && copy()) run((r) => deleteItems(r, sel.kind, sel.indices));
      select(null);
    },
  },
  { id: "edit.paste", label: "Paste at cursor", group: "Edit", keys: "Ctrl+V", key: k("ctrl+v"), enabled: (s) => !!s.clipboard && hasRoom(s), run: () => pasteAt() },
  {
    id: "edit.duplicate",
    label: "Duplicate",
    group: "Edit",
    keys: "Ctrl+D",
    key: k("ctrl+d"),
    enabled: anySelection,
    modes: ["vertex", "linedef", "sector", "thing"],
    run: () => {
      if (copy()) pasteAt(64, -64);
    },
  },
  {
    id: "edit.delete",
    label: "Delete",
    group: "Edit",
    keys: "Del",
    key: (e) => k("delete")(e) || k("backspace")(e),
    enabled: anySelection,
    modes: ["vertex", "linedef", "sector", "thing"],
    run: async () => {
      const sel = editor.get().selection;
      if (!sel) return;
      if (sel.kind === "thing" && sel.indices.some((i) => i < 2) && editor.get().target === "104") {
        if (!(await confirmDialog("Delete a room-box corner?", "Server 104 only loads rooms with exactly two things, and the corners set the Kod row/col origin.", "Delete"))) return;
      }
      run((r) => deleteItems(r, sel.kind, sel.indices), `Deleted ${sel.indices.length} ${sel.kind}(s).`);
      select(null);
    },
  },
  {
    id: "edit.selectAll",
    label: "Select all",
    group: "Edit",
    keys: "Ctrl+A",
    key: k("ctrl+a"),
    enabled: hasRoom,
    run: () => {
      const { room, mode: m } = editor.get();
      if (room) select({ kind: m, indices: Array.from({ length: count(room, m) }, (_, i) => i) });
    },
  },
  {
    id: "edit.deselect",
    label: "Clear selection / cancel",
    group: "Edit",
    keys: "Esc",
    key: k("escape"),
    run: () => {
      if (editor.get().tool !== "select") setTool("select");
      else select(null);
    },
  },
  { id: "edit.rotateScale", label: "Rotate and scale…", group: "Edit", enabled: anySelection, modes: ["vertex", "linedef", "sector", "thing"], run: rotateScaleDialog },
  {
    id: "edit.mirrorH",
    label: "Mirror left–right",
    group: "Edit",
    enabled: anySelection,
    modes: ["linedef", "sector", "thing"],
    run: () => {
      const s = editor.get().selection;
      if (s) run((r) => mirror(r, s.kind, s.indices, true), "Mirrored.");
    },
  },
  {
    id: "edit.mirrorV",
    label: "Mirror top–bottom",
    group: "Edit",
    enabled: anySelection,
    modes: ["linedef", "sector", "thing"],
    run: () => {
      const s = editor.get().selection;
      if (s) run((r) => mirror(r, s.kind, s.indices, false), "Mirrored.");
    },
  },
  { id: "edit.preferences", label: "Preferences…", group: "Edit", keys: "Ctrl+,", key: k("ctrl+,"), global: true, run: preferencesDialog },

  // Modes and tools
  mode("thing", "Things mode", "t"),
  mode("vertex", "Vertices mode", "v"),
  mode("linedef", "Linedefs mode", "l"),
  mode("sector", "Sectors mode", "s"),
  {
    id: "mode.prev",
    label: "Previous mode",
    group: "Mode",
    keys: "Shift+Tab",
    key: k("shift+tab"),
    run: () => {
      const order: ItemKind[] = ["thing", "vertex", "linedef", "sector"];
      setMode(order[(order.indexOf(editor.get().mode) + 3) % 4]!);
    },
  },
  {
    id: "mode.next",
    label: "Next mode",
    group: "Mode",
    keys: "Tab",
    key: k("tab"),
    run: () => {
      const order: ItemKind[] = ["thing", "vertex", "linedef", "sector"];
      setMode(order[(order.indexOf(editor.get().mode) + 1) % 4]!);
    },
  },
  tool("select", "Select tool", "Q", "q"),
  tool("draw", "Draw lines", "D", "d"),
  tool("rectangle", "Rectangle", "R", "r"),
  tool("polygon", "Polygon", "4", "4"),
  tool("circle", "Circle", "5", "5"),
  tool("torch", "Torch", "6", "6"),
  tool("thing", "Add thing", "7", "7"),

  // View
  { id: "view.2d", label: "Map view", group: "View", keys: "Ctrl+1", key: k("ctrl+1"), global: true, run: () => editor.set({ view: "2d" }) },
  { id: "view.3d", label: "3D preview", group: "View", keys: "Ctrl+2", key: k("ctrl+2"), global: true, run: () => editor.set({ view: "3d" }) },
  { id: "view.split", label: "Split view", group: "View", keys: "Ctrl+3", key: k("ctrl+3"), global: true, run: () => editor.set({ view: "split" }) },
  { id: "view.fit", label: "Fit room", group: "View", keys: "F", key: k("f"), enabled: hasRoom, run: () => requestView({ kind: "fit" }) },
  { id: "view.center", label: "Center on selection", group: "View", keys: "C", key: k("c"), enabled: anySelection, modes: ["vertex", "linedef", "sector", "thing"], run: centerOnSelection },
  {
    id: "view.gridNext",
    label: "Bigger grid",
    group: "View",
    keys: "G",
    key: k("g"),
    run: () => editor.set((s) => ({ grid: Math.min(256, s.grid * 2) })),
  },
  {
    id: "view.gridPrev",
    label: "Smaller grid",
    group: "View",
    keys: "Shift+G",
    key: k("shift+g"),
    run: () => editor.set((s) => ({ grid: Math.max(1, s.grid / 2) })),
  },
  { id: "view.zoomIn", label: "Zoom in", group: "View", keys: "+", key: (e) => !e.ctrlKey && (e.key === "+" || e.key === "="), enabled: hasRoom, run: () => requestView({ kind: "zoom", factor: 1.5 }) },
  { id: "view.zoomOut", label: "Zoom out", group: "View", keys: "-", key: (e) => !e.ctrlKey && (e.key === "-" || e.key === "_"), enabled: hasRoom, run: () => requestView({ kind: "zoom", factor: 1 / 1.5 }) },
  {
    id: "view.walk",
    label: "Walk in 3D",
    group: "View",
    keys: "Shift+W",
    key: k("shift+w"),
    enabled: hasRoom,
    run: () => (walk.get().active ? stopWalk() : startWalk()),
  },
  {
    id: "view.walkHere",
    label: "Walk from here",
    group: "View",
    enabled: hasRoom,
    modes: ["vertex", "linedef", "sector", "thing"],
    run: () => {
      const room = editor.get().room;
      const c = cursor.get();
      const at = room && editorToClient(room.things, c.x, c.y);
      if (at) startWalk(at);
    },
  },
  { id: "view.lighting", label: "Lighting…", group: "View", run: () => void lightingDialog() },
  {
    id: "view.flatLight",
    label: "Flat lighting",
    group: "View",
    run: () => editor.set((s) => ({ light: { ...s.light, mode: s.light.mode === "flat" ? "game" : "flat" } })),
  },
  { id: "view.kod", label: "Show Kod placements", group: "View", keys: "K", key: k("k"), run: () => kod.set((s) => ({ show: !s.show })) },
  { id: "view.kodReload", label: "Reload Kod", group: "View", run: () => void reloadKod().then(() => notify(kod.get().error ?? "Reloaded the Kod.")) },
  {
    id: "view.kodPosition",
    label: "Copy Kod position here",
    group: "View",
    enabled: hasRoom,
    modes: ["vertex", "linedef", "sector", "thing"],
    run: () => void copyKodPosition(),
  },
  { id: "view.toggleGrid", label: "Show grid", group: "View", keys: "H", key: k("h"), run: () => editor.set((s) => ({ showGrid: !s.showGrid })) },
  { id: "view.toggleSnap", label: "Snap to grid", group: "View", keys: "Shift+H", key: k("shift+h"), run: () => editor.set((s) => ({ snap: !s.snap })) },
  { id: "view.palette", label: "Command palette…", group: "View", keys: "Ctrl+Shift+P", key: (e) => k("ctrl+shift+p")(e) || k("f1")(e), global: true, run: () => void openPalette() },

  // Vertices
  {
    id: "vertex.link",
    label: "Add linedefs between vertices",
    group: "Vertices",
    keys: "Ins",
    key: k("insert"),
    modes: ["vertex"],
    enabled: selected("vertex", 2),
    run: () => {
      const v = need("vertex", 2);
      if (v) runSelect((r) => ((x) => ({ room: x.room, selection: { kind: "linedef", indices: x.linedefs } }))(linkVertices(r, v, false)), "Added linedefs.");
    },
  },
  {
    id: "vertex.add",
    label: "Add vertex at cursor",
    group: "Vertices",
    keys: "Ins",
    key: k("insert"),
    modes: ["vertex"],
    enabled: (s) => hasRoom(s) && s.mode === "vertex" && !(s.selection?.kind === "vertex" && s.selection.indices.length >= 2),
    run: () => {
      const { grid, snap } = editor.get();
      const c = cursor.get();
      if (!c.inside) return notify("Point at the map to add a vertex there.", "error");
      const x = snap ? Math.round(c.x / grid) * grid : Math.round(c.x);
      const y = snap ? Math.round(c.y / grid) * grid : Math.round(c.y);
      runSelect((r) => ((out) => ({ room: out.room, selection: { kind: "vertex", indices: [out.vertex] } }))(addVertex(r, x, y)), "Added a vertex.");
    },
  },
  {
    id: "vertex.linkClosed",
    label: "Add linedefs and close the loop",
    group: "Vertices",
    keys: "Shift+Ins",
    key: k("shift+insert"),
    modes: ["vertex"],
    enabled: selected("vertex", 3),
    run: () => {
      const v = need("vertex", 3);
      if (v) runSelect((r) => ((x) => ({ room: x.room, selection: { kind: "linedef", indices: x.linedefs } }))(linkVertices(r, v, true)), "Added linedefs.");
    },
  },
  {
    id: "vertex.deleteJoin",
    label: "Delete vertex and join linedefs",
    group: "Vertices",
    modes: ["vertex"],
    enabled: selected("vertex"),
    run: () => {
      const v = need("vertex");
      if (!v) return;
      // Highest first so earlier indices stay valid.
      if (run((r) => [...v].sort((a, b) => b - a).reduce(deleteVertexJoinLinedefs, r), "Joined linedefs.")) select(null);
    },
  },
  {
    id: "vertex.merge",
    label: "Merge vertices into one",
    group: "Vertices",
    keys: "M",
    key: k("m"),
    modes: ["vertex"],
    enabled: selected("vertex", 2),
    run: () => {
      const v = need("vertex", 2);
      if (v && run((r) => mergeVertices(r, v), "Merged vertices.")) select(null);
    },
  },
  {
    id: "vertex.splitSector",
    label: "Add a linedef and split the sector",
    group: "Vertices",
    modes: ["vertex"],
    enabled: selected("vertex", 2),
    run: () => {
      const v = need("vertex", 2, "Select two vertices on the same sector.");
      if (v) runSelect((r) => ((x) => ({ room: x.room, selection: x.sectors.length ? { kind: "sector", indices: x.sectors } : null }))(connectVertices(r, v[0]!, v[1]!, editor.get().prefs.defaults)), "Split the sector.");
    },
  },

  // Linedefs
  {
    id: "linedef.split",
    label: "Split linedef (add vertex)",
    group: "Linedefs",
    keys: "X",
    key: k("x"),
    modes: ["linedef"],
    enabled: selected("linedef"),
    run: () => {
      const l = need("linedef");
      if (l) runSelect((r) => ((x) => ({ room: x.room, selection: { kind: "vertex", indices: x.vertices } }))(splitLinedefs(r, l)), "Split.");
    },
  },
  {
    id: "linedef.splitSector",
    label: "Split linedefs and sector",
    group: "Linedefs",
    modes: ["linedef"],
    enabled: selected("linedef", 2),
    run: () => {
      const l = need("linedef", 2, "Select two linedefs of the same sector.");
      if (l) runSelect((r) => ((x) => ({ room: x.room, selection: x.sectors.length ? { kind: "sector", indices: x.sectors } : null }))(splitLinedefsAndSector(r, l[0]!, l[1]!, editor.get().prefs.defaults)), "Split the sector.");
    },
  },
  {
    id: "linedef.deleteJoin",
    label: "Delete linedefs and join sectors",
    group: "Linedefs",
    modes: ["linedef"],
    enabled: selected("linedef"),
    run: () => {
      const l = need("linedef");
      if (l && run((r) => deleteLinedefsJoinSectors(r, l), "Joined sectors.")) select(null);
    },
  },
  {
    id: "linedef.flip",
    label: "Flip linedef",
    group: "Linedefs",
    keys: "Shift+F",
    key: k("shift+f"),
    modes: ["linedef"],
    enabled: selected("linedef"),
    run: () => {
      const l = need("linedef");
      if (l) run((r) => flipLinedefs(r, l, true), "Flipped.");
    },
  },
  {
    id: "linedef.swap",
    label: "Swap sides",
    group: "Linedefs",
    modes: ["linedef"],
    enabled: selected("linedef"),
    run: () => {
      const l = need("linedef");
      if (l) run((r) => flipLinedefs(r, l, false), "Swapped sides.");
    },
  },
  {
    id: "linedef.makeSector",
    label: "Make a sector from linedefs",
    group: "Linedefs",
    modes: ["linedef"],
    enabled: selected("linedef"),
    run: () => {
      const l = need("linedef");
      if (l) runSelect((r) => ((x) => ({ room: x.room, selection: { kind: "sector", indices: [x.sector] } }))(makeSectorFromLinedefs(r, l, editor.get().prefs.defaults)), "Added a sector.");
    },
  },
  {
    id: "linedef.alignY",
    label: "Align textures (Y offset)",
    group: "Linedefs",
    modes: ["linedef"],
    enabled: selected("linedef"),
    run: () => {
      const l = need("linedef");
      if (l) run((r) => alignTexturesY(r, l), "Aligned y offsets.");
    },
  },
  { id: "linedef.alignX", label: "Align textures (X offset)…", group: "Linedefs", modes: ["linedef"], enabled: selected("linedef"), run: alignXDialog },

  // Sectors
  {
    id: "sector.merge",
    label: "Merge sectors",
    group: "Sectors",
    modes: ["sector"],
    enabled: selected("sector", 2),
    run: () => {
      const s = need("sector", 2);
      // The first selected sector survives; deleting the others shifts it down past any lower ones.
      if (s && run((r) => mergeSectors(r, s), "Merged sectors.")) select({ kind: "sector", indices: [s[0]! - s.filter((x) => x < s[0]!).length] });
    },
  },
  {
    id: "sector.door",
    label: "Make door from sector",
    group: "Sectors",
    modes: ["sector"],
    enabled: selected("sector", 1),
    run: () => {
      const s = need("sector");
      if (s) run((r) => makeDoor(r, s[0]!), "Made a door: it's closed, with a server id for Kod's SetSector.");
    },
  },
  {
    id: "sector.lift",
    label: "Make lift from sector",
    group: "Sectors",
    modes: ["sector"],
    enabled: selected("sector", 1),
    run: () => {
      const s = need("sector");
      if (s) run((r) => makeLift(r, s[0]!), "Made a lift.");
    },
  },
  {
    id: "sector.distFloor",
    label: "Distribute floor heights",
    group: "Sectors",
    modes: ["sector"],
    enabled: selected("sector", 3),
    run: () => {
      const s = need("sector", 3, "Select three or more sectors, in order.");
      if (s) run((r) => distributeHeights(r, s, "floor"), "Distributed floor heights.");
    },
  },
  {
    id: "sector.distCeiling",
    label: "Distribute ceiling heights",
    group: "Sectors",
    modes: ["sector"],
    enabled: selected("sector", 3),
    run: () => {
      const s = need("sector", 3, "Select three or more sectors, in order.");
      if (s) run((r) => distributeHeights(r, s, "ceiling"), "Distributed ceiling heights.");
    },
  },
  {
    id: "sector.freeId",
    label: "Give a free server id",
    group: "Sectors",
    modes: ["sector"],
    enabled: selected("sector"),
    run: () => {
      const s = need("sector");
      if (!s) return;
      run((r) => s.reduce((acc, i) => ({ ...acc, sectors: acc.sectors.map((sec, j) => (j === i && sec.serverId === 0 ? { ...sec, serverId: freeSectorServerId(acc) } : sec)) }), r), "Assigned server ids.");
    },
  },
  {
    id: "sector.floorSlope",
    label: "Add floor slope",
    group: "Sectors",
    modes: ["sector"],
    enabled: selected("sector"),
    run: () => {
      const s = need("sector");
      if (s) run((r) => addSlope(r, s[0]!, true), "Added a floor slope; set its point heights in the inspector.");
    },
  },
  {
    id: "sector.ceilingSlope",
    label: "Add ceiling slope",
    group: "Sectors",
    modes: ["sector"],
    enabled: selected("sector"),
    run: () => {
      const s = need("sector");
      if (s) run((r) => addSlope(r, s[0]!, false), "Added a ceiling slope; set its point heights in the inspector.");
    },
  },

  // Kod exits (the room class's plExits, saved with the room)
  { id: "kod.editExit", label: "Edit Kod exit…", group: "Kod", keys: "Enter", key: k("enter"), enabled: kodExitPicked, modes: ALL_MODES, run: editKodExit },
  { id: "kod.deleteExit", label: "Delete Kod exit", group: "Kod", keys: "Del", key: (e) => k("delete")(e) || k("backspace")(e), enabled: kodExitPicked, modes: ALL_MODES, run: deleteKodExit },
  { id: "kod.addExit", label: "Add Kod exit or locked door here…", group: "Kod", enabled: hasRoom, modes: ALL_MODES, run: addKodExit },

  // Search
  { id: "search.find", label: "Find / change…", group: "Search", keys: "Ctrl+F", key: k("ctrl+f"), global: true, enabled: hasRoom, run: findDialog },
  { id: "search.jump", label: "Jump to object…", group: "Search", keys: "Ctrl+J", key: k("ctrl+j"), enabled: hasRoom, run: jumpDialog },
  { id: "search.next", label: "Next object", group: "Search", keys: "N", key: k("n"), enabled: hasRoom, run: () => step(1) },
  { id: "search.prev", label: "Previous object", group: "Search", keys: "P", key: k("p"), enabled: hasRoom, run: () => step(-1) },

  // Check
  { id: "check.stats", label: "Statistics", group: "Check", enabled: hasRoom, run: statsDialog },
  { id: "check.sectors", label: "Check sectors are closed", group: "Check", enabled: hasRoom, run: () => runChecks("sectors") },
  { id: "check.crossrefs", label: "Check cross-references", group: "Check", enabled: hasRoom, run: () => runChecks("crossrefs") },
  { id: "check.textures", label: "Check missing textures", group: "Check", enabled: hasRoom, run: () => runChecks("textures") },
  { id: "check.textureNames", label: "Check texture names", group: "Check", enabled: hasRoom, run: () => runChecks("names") },
  { id: "check.kod", label: "Check Kod placements", group: "Check", enabled: hasRoom, run: () => runChecks("kod") },
  { id: "check.all", label: "Run all checks", group: "Check", keys: "F9", key: k("f9"), global: true, enabled: hasRoom, run: () => runChecks("all") },

  // Textures
  { id: "textures.browse", label: "Browse textures…", group: "Textures", run: () => void browseTextures() },
  { id: "textures.reload", label: "Reload texture library", group: "Textures", run: () => void reloadLibrary() },
];

export const commandById = new Map(COMMANDS.map((c) => [c.id, c]));

export function runCommand(id: string): void {
  const c = commandById.get(id);
  if (!c) return;
  if (c.enabled && !c.enabled(editor.get())) return;
  try {
    const out = c.run();
    if (out instanceof Promise) out.catch(report);
  } catch (e) {
    report(e);
  }
}

function report(e: unknown): void {
  if (e instanceof OpError) notify(e.message, "error");
  else {
    console.error(e);
    notify((e as Error).message, "error");
  }
}

/** Keyboard dispatch: the first matching command wins. */
export function handleKey(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
  const state = editor.get();
  for (const c of COMMANDS) {
    if (!c.key || (typing && !c.global) || !c.key(e)) continue;
    // A disabled command lets the next one with the same key have a go (Insert does two things).
    if (c.enabled && !c.enabled(state)) continue;
    e.preventDefault();
    runCommand(c.id);
    return true;
  }
  return false;
}

// The palette is opened from here; App renders it.
export const palette = { open: false, listeners: new Set<() => void>() };
export function openPalette(): void {
  palette.open = true;
  for (const l of palette.listeners) l();
}
