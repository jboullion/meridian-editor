// Editor state: the open room, its undo history, mode, tool, selection,
// view settings and preferences. A tiny external store read through
// useSyncExternalStore.

import { useSyncExternalStore } from "react";
import type { RoomSource } from "@meridian-editor/roomc";
import type { TargetName } from "@meridian-editor/roo";
import type { CheckIssue } from "./ops/checks.ts";
import { ROOMEDIT_DEFAULTS, type DrawDefaults } from "./ops/draw.ts";
import type { Clipboard } from "./ops/edit.ts";
import { OpError, type ItemKind, type ItemRef } from "./ops/types.ts";

export type { ItemKind, ItemRef };
export type ViewMode = "2d" | "3d" | "split";
export type Tool = "select" | "draw" | "rectangle" | "polygon" | "circle" | "torch" | "thing";

/** Selected items, all of one kind, in the order they were picked (some operations care). */
export interface Selection {
  kind: ItemKind;
  indices: number[];
}

export interface DocRef {
  /** Host id to save back to; null when the room came from a .roo or a browser upload. */
  id: string | null;
  name: string;
}

export interface Prefs {
  /** What new sectors and sides start as (roomedit's Default* settings). */
  defaults: DrawDefaults;
  polygonSides: number;
  /** Shapes drawn inside a sector become solid columns instead of inner sectors. */
  pillar: boolean;
  /** Torch direction in degrees: 0 north, 90 east, 180 south, 270 west. */
  torchAngle: number;
  /** Folder holding grdNNNNN.bgf textures; empty means the default. */
  texturesDir: string;
  /** The server's Kod folder (room classes and blakston.khd); empty means meridian-browser's, beside this repo. */
  kodDir: string;
}

export interface PreviewLight {
  /** "game": the client's lighting with the room's Kod light at `hour`; "flat": each sector's light level. */
  mode: "game" | "flat";
  /** Game hour, 0..23. */
  hour: number;
  /** The player's own light, 0..255 (5 unless a spell or item changes it). */
  playerLight: number;
  /** Fade to black with distance, as the client does (while walking). */
  fog: boolean;
  /** Light from the Kod objects the room places (fires, lamps, candles, signs). */
  sources: boolean;
}

export interface EditorState {
  doc: DocRef | null;
  room: RoomSource | null;
  /** The room as last saved, to tell whether there are unsaved changes. */
  saved: RoomSource | null;
  undo: RoomSource[];
  redo: RoomSource[];
  mode: ItemKind;
  tool: Tool;
  selection: Selection | null;
  hover: ItemRef | null;
  target: TargetName;
  view: ViewMode;
  grid: number;
  snap: boolean;
  showGrid: boolean;
  colorBy: "floor" | "light" | "ceiling";
  /** Draw ceilings in the 3D preview (they hide the floors from above). */
  ceilings: boolean;
  /** How the 3D preview lights the room. */
  light: PreviewLight;
  message: { text: string; kind: "info" | "error" } | null;
  prefs: Prefs;
  clipboard: Clipboard | null;
  /** Results of the last Check command. */
  issues: { title: string; items: CheckIssue[] } | null;
  /** Ask the map to frame something; `seq` makes repeats count. */
  viewRequest: { kind: "fit" } | { kind: "center"; x: number; y: number } | { kind: "zoom"; factor: number } | null;
  viewSeq: number;
}

const MAX_UNDO = 200;
const PREFS_KEY = "meridian-editor.prefs";

export class Store<T> {
  private state: T;
  private readonly listeners = new Set<() => void>();
  constructor(initial: T) {
    this.state = initial;
  }
  get = (): T => this.state;
  set = (patch: Partial<T> | ((s: T) => Partial<T>)): void => {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  };
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

const DEFAULT_PREFS: Prefs = { defaults: ROOMEDIT_DEFAULTS, polygonSides: 8, pillar: false, torchAngle: 0, texturesDir: "", kodDir: "" };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return { ...DEFAULT_PREFS, ...p, defaults: { ...DEFAULT_PREFS.defaults, ...p.defaults } };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: Prefs): void {
  editor.set({ prefs });
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Preferences just won't persist.
  }
}

export const editor = new Store<EditorState>({
  doc: null,
  room: null,
  saved: null,
  undo: [],
  redo: [],
  mode: "sector",
  tool: "select",
  selection: null,
  hover: null,
  target: "104",
  view: "split",
  grid: 16,
  snap: true,
  showGrid: true,
  colorBy: "floor",
  ceilings: false,
  light: { mode: "game", hour: 12, playerLight: 5, fog: true, sources: true },
  message: null,
  prefs: loadPrefs(),
  clipboard: null,
  issues: null,
  viewRequest: null,
  viewSeq: 0,
});

export function useEditor<R>(select: (s: EditorState) => R): R {
  return useSyncExternalStore(editor.subscribe, () => select(editor.get()));
}

export const isDirty = (s: EditorState): boolean => s.room !== s.saved;

export function loadRoom(doc: DocRef, room: RoomSource, saved: RoomSource | null = room): void {
  editor.set({ doc, room, saved, undo: [], redo: [], selection: null, hover: null, issues: null, tool: "select" });
  requestView({ kind: "fit" });
}

export function requestView(request: NonNullable<EditorState["viewRequest"]>): void {
  editor.set((s) => ({ viewRequest: request, viewSeq: s.viewSeq + 1 }));
}

/** One undoable change. */
export function edit(fn: (room: RoomSource) => RoomSource): boolean {
  const { room, undo } = editor.get();
  if (!room) return false;
  let next: RoomSource;
  try {
    next = fn(room);
  } catch (e) {
    if (e instanceof OpError) {
      notify(e.message, "error");
      return false;
    }
    throw e;
  }
  if (next === room) return false;
  editor.set({ room: next, undo: [...undo, room].slice(-MAX_UNDO), redo: [], selection: validSelection(next, editor.get().selection) });
  return true;
}

// A gesture (such as a drag) changes the room many times but undoes in one step.
let gestureStart: RoomSource | null = null;

export function beginGesture(): void {
  gestureStart = editor.get().room;
}

export function previewEdit(fn: (room: RoomSource) => RoomSource): void {
  if (!editor.get().room || !gestureStart) return;
  editor.set({ room: fn(gestureStart) });
}

export function endGesture(): void {
  const start = gestureStart;
  gestureStart = null;
  const { room, undo } = editor.get();
  if (!start || room === start) return;
  editor.set({ undo: [...undo, start].slice(-MAX_UNDO), redo: [] });
}

export function undo(): void {
  const { room, undo, redo } = editor.get();
  const prev = undo[undo.length - 1];
  if (!room || !prev) return;
  editor.set({ room: prev, undo: undo.slice(0, -1), redo: [...redo, room], selection: validSelection(prev, editor.get().selection) });
}

export function redo(): void {
  const { room, undo, redo } = editor.get();
  const next = redo[redo.length - 1];
  if (!room || !next) return;
  editor.set({ room: next, redo: redo.slice(0, -1), undo: [...undo, room], selection: validSelection(next, editor.get().selection) });
}

export function select(selection: Selection | null): void {
  if (selection && selection.indices.length === 0) selection = null;
  editor.set(selection && selection.kind !== editor.get().mode ? { selection, mode: selection.kind } : { selection });
}

export function selectOne(ref: ItemRef | null): void {
  select(ref ? { kind: ref.kind, indices: [ref.index] } : null);
}

/** Add or remove one item, switching the selection's kind if needed. */
export function toggleSelected(ref: ItemRef): void {
  const sel = editor.get().selection;
  if (!sel || sel.kind !== ref.kind) return selectOne(ref);
  const has = sel.indices.includes(ref.index);
  select({ kind: ref.kind, indices: has ? sel.indices.filter((i) => i !== ref.index) : [...sel.indices, ref.index] });
}

export function isSelected(sel: Selection | null, ref: ItemRef): boolean {
  return !!sel && sel.kind === ref.kind && sel.indices.includes(ref.index);
}

export function setMode(mode: ItemKind): void {
  const s = editor.get();
  if (s.mode === mode) return;
  editor.set({ mode, selection: null, hover: null });
}

export function setTool(tool: Tool): void {
  editor.set({ tool });
}

export function notify(text: string, kind: "info" | "error" = "info"): void {
  editor.set({ message: { text, kind } });
}

export function count(room: RoomSource, kind: ItemKind): number {
  return { vertex: room.vertices.length, linedef: room.linedefs.length, sector: room.sectors.length, thing: room.things.length }[kind];
}

function validSelection(room: RoomSource, sel: Selection | null): Selection | null {
  if (!sel) return null;
  const n = count(room, sel.kind);
  const indices = sel.indices.filter((i) => i < n);
  return indices.length ? { kind: sel.kind, indices } : null;
}

/** Cursor position, kept apart so mouse moves don't re-render the whole app. */
export const cursor = new Store<{ x: number; y: number; inside: boolean }>({ x: 0, y: 0, inside: false });
export function useCursor(): { x: number; y: number; inside: boolean } {
  return useSyncExternalStore(cursor.subscribe, cursor.get);
}
