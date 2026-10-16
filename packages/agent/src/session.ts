// What the agent's tools work on: one open room with its undo history, the
// compile target, drawing defaults and the Kod and texture libraries. The tools
// only use the Session interface; HeadlessSession keeps the room in memory and
// reads and writes files itself. A live session (the running editor) will
// implement the same interface over the editor's bridge.

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getProfile, readRoo, type RooFile, type TargetName } from "@meridian-editor/roo";
import { CompileError, compileRoom, formatRoomSource, importRoo, parseRoomSource, validateSource, type Diagnostic, type RoomSource } from "@meridian-editor/roomc";
import { ROOMEDIT_DEFAULTS, type DrawDefaults } from "../../../apps/editor/src/renderer/ops/draw.ts";
import { OpError, type ItemKind } from "../../../apps/editor/src/renderer/ops/types.ts";
import type { CheckIssue } from "../../../apps/editor/src/renderer/ops/checks.ts";
import { buildKodIndex, kodCandidates, type KodIndex, type KodRoom } from "../../../apps/editor/src/renderer/kod/kodRooms.ts";
import { buildLightIndex, type KodLightIndex } from "../../../apps/editor/src/renderer/kod/kodLights.ts";
import { readKodSources, type KodSources } from "../../../apps/editor/src/main/kod.ts";
import { listRooms, resolveInside } from "../../../apps/editor/src/main/roomsFs.ts";
import { listTextures } from "../../../apps/editor/src/main/textures.ts";
import type { AgentCall } from "../../../apps/editor/src/main/agentProtocol.ts";

export { OpError };

export interface Selection {
  kind: ItemKind;
  indices: number[];
}

export interface DocRef {
  /** Absolute path of the .room.json to save back to; null until saved (new rooms, imports). */
  path: string | null;
  /** The room's name: the file name without .room.json, which is also its .roo name. */
  name: string;
}

/** The editor's Preferences that change what edits make. */
export interface AgentPrefs {
  defaults: DrawDefaults;
  polygonSides: number;
  pillar: boolean;
  torchAngle: number;
  texturesDir: string;
  kodDir: string;
}

export type CompileOutcome =
  | { ok: true; target: TargetName; file: RooFile; bytes: Uint8Array; origin: { x: number; y: number }; diagnostics: Diagnostic[]; ms: number }
  | { ok: false; target: TargetName; diagnostics: Diagnostic[]; ms: number };

export interface KodLibrary {
  index: KodIndex | null;
  lights: KodLightIndex | null;
  error: string | null;
}

export interface Session {
  readonly backend: "headless" | "live";
  /** The running editor, when attached to one (live tools need it). */
  editor(): EditorLink | null;
  /** Live sessions: read the editor's state before a tool runs, and send its changes after. */
  sync?(): Promise<void>;
  flush?(): Promise<void>;
  /** The rooms folder: room paths are relative to it. */
  readonly roomsDir: string;
  /** This repo's root, for rooms/out and the Shards tools; "" when there isn't one. */
  readonly repoRoot: string;

  doc(): DocRef | null;
  /** The open room; throws if there isn't one. */
  room(): RoomSource;
  hasRoom(): boolean;
  dirty(): boolean;
  /** Bumped by every change to the room (edits, undo, redo, opening). */
  revision(): number;
  undoDepth(): number;
  redoDepth(): number;

  /** Replace the document (open, import, new). */
  load(doc: DocRef, room: RoomSource, saved: RoomSource | null): void;
  /** One undoable change, labelled for the history. Returns false if nothing changed. */
  apply(label: string, fn: (room: RoomSource) => RoomSource): boolean;
  /** Several changes as one undo step; if `fn` throws, none of them stay. */
  transaction<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /** Undo or redo one step; returns what it was, or null if there was nothing to do. */
  undo(): Promise<string | null>;
  redo(): Promise<string | null>;
  /** Labels of the undo steps, oldest first. */
  history(): string[];

  save(path?: string): Promise<string>;
  /** Compile (cached per room and target). */
  compile(target?: TargetName): CompileOutcome;
  target(): TargetName;
  setTarget(target: TargetName): void;

  prefs(): AgentPrefs;
  setPrefs(prefs: AgentPrefs): void;

  selection(): Selection | null;
  select(selection: Selection | null): void;

  kod(reload?: boolean): Promise<KodLibrary>;
  /** The Kod class for the open room, and the others that use its .roo. */
  kodRoom(): Promise<{ candidates: KodRoom[]; room: KodRoom | null; error: string | null }>;
  pickKodClass(className: string): void;
  /** A new room's .kod (rooms/new) was written. */
  newRoomKodChanged(): void;
  /** grdNNNNN.bgf numbers in the texture folder, or null if there is no folder. */
  knownTextures(fresh?: boolean): Promise<ReadonlySet<number> | null>;

  /** Results of the last check, for fix_issue. */
  lastIssues(): CheckIssue[];
  setIssues(issues: CheckIssue[]): void;
}

/** Calls to a running editor (live.ts). */
export interface EditorLink {
  call<T>(call: AgentCall): Promise<T>;
  readonly kind: "electron" | "web";
}

const MAX_UNDO = 200;

export const DEFAULT_PREFS: AgentPrefs = { defaults: ROOMEDIT_DEFAULTS, polygonSides: 8, pillar: false, torchAngle: 0, texturesDir: "", kodDir: "" };

/** Room sources and imports from disk, the way the editor's Open does. */
export function parseRoomFile(text: string): RoomSource {
  const room = parseRoomSource(text);
  if (room.format !== "meridian-room") throw new OpError("Not a room source (format is not meridian-room).");
  const errors = validateSource(room).filter((d) => d.severity === "error");
  if (errors.length) throw new OpError(errors[0]!.message);
  return room;
}

export function roomName(path: string): string {
  return basename(path).replace(/\.room\.json$|\.json$|\.roo$/i, "");
}

export class HeadlessSession implements Session {
  readonly backend: "headless" | "live" = "headless";
  protected _doc: DocRef | null = null;
  protected _room: RoomSource | null = null;
  protected saved: RoomSource | null = null;
  protected undoStack: { room: RoomSource; label: string }[] = [];
  protected redoStack: { room: RoomSource; label: string }[] = [];
  protected rev = 0;
  protected _target: TargetName = "104";
  protected _prefs: AgentPrefs = DEFAULT_PREFS;
  protected _selection: Selection | null = null;
  protected issues: CheckIssue[] = [];
  protected txDepth = 0;
  protected compileCache = new Map<TargetName, { room: RoomSource; out: CompileOutcome }>();
  protected kodSrc: KodSources | null = null;
  protected kodLib: KodLibrary | null = null;
  protected kodPicked: Record<string, string> = {};
  protected textures: { dir: string; numbers: ReadonlySet<number> | null } | null = null;

  protected _roomsDir: string;
  readonly repoRoot: string;

  constructor(roomsDir: string, repoRoot: string) {
    this._roomsDir = roomsDir;
    this.repoRoot = repoRoot;
  }

  get roomsDir(): string {
    return this._roomsDir;
  }

  editor(): EditorLink | null {
    return null;
  }

  doc(): DocRef | null {
    return this._doc;
  }

  room(): RoomSource {
    if (!this._room) throw new OpError("No room is open: use open_room, import_roo or new_room first.");
    return this._room;
  }

  hasRoom(): boolean {
    return this._room !== null;
  }

  dirty(): boolean {
    return this._room !== this.saved;
  }

  revision(): number {
    return this.rev;
  }

  undoDepth(): number {
    return this.undoStack.length;
  }

  redoDepth(): number {
    return this.redoStack.length;
  }

  history(): string[] {
    return this.undoStack.map((u) => u.label);
  }

  load(doc: DocRef, room: RoomSource, saved: RoomSource | null): void {
    this._doc = doc;
    this._room = room;
    this.saved = saved;
    this.undoStack = [];
    this.redoStack = [];
    this._selection = null;
    this.issues = [];
    this.rev++;
  }

  apply(label: string, fn: (room: RoomSource) => RoomSource): boolean {
    const room = this.room();
    const next = fn(room);
    if (next === room) return false;
    if (this.txDepth === 0) {
      this.undoStack = [...this.undoStack, { room, label }].slice(-MAX_UNDO);
      this.redoStack = [];
    }
    this._room = next;
    this._selection = validSelection(next, this._selection);
    this.rev++;
    return true;
  }

  async transaction<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.txDepth > 0) return fn();
    const start = this.room();
    this.txDepth = 1;
    try {
      return await fn();
    } catch (e) {
      if (this._room !== start) {
        this._room = start;
        this._selection = validSelection(start, this._selection);
        this.rev++;
      }
      throw e;
    } finally {
      this.txDepth = 0;
      if (this._room !== start) {
        this.undoStack = [...this.undoStack, { room: start, label }].slice(-MAX_UNDO);
        this.redoStack = [];
      }
    }
  }

  async undo(): Promise<string | null> {
    const prev = this.undoStack[this.undoStack.length - 1];
    if (!this._room || !prev) return null;
    this.undoStack = this.undoStack.slice(0, -1);
    this.redoStack = [...this.redoStack, { room: this._room, label: prev.label }];
    this._room = prev.room;
    this._selection = validSelection(prev.room, this._selection);
    this.rev++;
    return prev.label;
  }

  async redo(): Promise<string | null> {
    const next = this.redoStack[this.redoStack.length - 1];
    if (!this._room || !next) return null;
    this.redoStack = this.redoStack.slice(0, -1);
    this.undoStack = [...this.undoStack, { room: this._room, label: next.label }];
    this._room = next.room;
    this._selection = validSelection(next.room, this._selection);
    this.rev++;
    return next.label;
  }

  async save(path?: string): Promise<string> {
    const room = this.room();
    const doc = this._doc!;
    let abs = doc.path;
    if (path) abs = resolveInside(this.roomsDir, path.endsWith(".json") ? path : `${path}.room.json`);
    if (!abs) throw new OpError(`${doc.name} has never been saved: give a path in the rooms folder, such as new/${doc.name}.room.json.`);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, formatRoomSource(room), "utf8");
    this._doc = { path: abs, name: roomName(abs) };
    this.saved = room;
    return abs;
  }

  compile(target: TargetName = this._target): CompileOutcome {
    const room = this.room();
    const hit = this.compileCache.get(target);
    if (hit && hit.room === room) return hit.out;
    const started = performance.now();
    let out: CompileOutcome;
    try {
      const r = compileRoom(room, getProfile(target));
      out = { ok: true, target, file: r.file, bytes: r.bytes, origin: r.origin, diagnostics: r.diagnostics, ms: performance.now() - started };
    } catch (e) {
      const diagnostics = e instanceof CompileError ? e.diagnostics : [{ severity: "error" as const, message: (e as Error).message }];
      out = { ok: false, target, diagnostics, ms: performance.now() - started };
    }
    this.compileCache.set(target, { room, out });
    return out;
  }

  target(): TargetName {
    return this._target;
  }

  setTarget(target: TargetName): void {
    this._target = target;
  }

  prefs(): AgentPrefs {
    return this._prefs;
  }

  setPrefs(prefs: AgentPrefs): void {
    if (prefs.kodDir !== this._prefs.kodDir) this.kodLib = null;
    if (prefs.texturesDir !== this._prefs.texturesDir) this.textures = null;
    this._prefs = prefs;
  }

  selection(): Selection | null {
    return this._selection;
  }

  select(selection: Selection | null): void {
    this._selection = selection && selection.indices.length ? selection : null;
  }

  /**
   * The server's room classes, plus new rooms' own (rooms/new/*.kod, ahead of
   * any installed copy). `reload` rereads the server's; new rooms' are reread
   * every time the index is rebuilt (newRoomKodChanged).
   */
  async kod(reload = false): Promise<KodLibrary> {
    if (this.kodLib && !reload) return this.kodLib;
    try {
      if (!this.kodSrc || reload) this.kodSrc = await readKodSources(this._prefs.kodDir, this.repoRoot);
      const src = this.kodSrc;
      const mine = await newRoomKod(this.roomsDir);
      this.kodLib = src.files.length
        ? { index: buildKodIndex(src.dir, [...mine, ...src.files], src.khd), lights: buildLightIndex(src.objectFiles), error: null }
        : { index: null, lights: null, error: src.dir ? `No room classes in ${src.dir}` : "No Kod folder: set kodDir with set_prefs (meridian-browser/server/src/kod)." };
    } catch (e) {
      this.kodLib = { index: null, lights: null, error: (e as Error).message };
    }
    return this.kodLib;
  }

  /** A new room's Kod changed: rebuild the index (the server's sources stay cached). */
  newRoomKodChanged(): void {
    this.kodLib = null;
  }

  async kodRoom(): Promise<{ candidates: KodRoom[]; room: KodRoom | null; error: string | null }> {
    const lib = await this.kod();
    if (!lib.index || !this._room) return { candidates: [], room: null, error: lib.error ?? (this._room ? null : "No room is open.") };
    const name = this._doc?.name;
    const candidates = kodCandidates(lib.index, name, this._room.roomId);
    const picked = name ? this.kodPicked[name] : undefined;
    const room = candidates.find((c) => c.className === picked) ?? candidates[0] ?? null;
    return { candidates, room, error: room ? null : `No Kod room class uses ${name ?? "this room"}.roo or RID ${this._room.roomId}.` };
  }

  pickKodClass(className: string): void {
    const name = this._doc?.name;
    if (name) this.kodPicked[name] = className;
  }

  async knownTextures(fresh = false): Promise<ReadonlySet<number> | null> {
    if (!fresh && this.textures?.dir === this._prefs.texturesDir) return this.textures.numbers;
    const out = await listTextures(this._prefs.texturesDir, this.repoRoot);
    const numbers = out.dir ? new Set(out.textures.map((t) => t.number)) : null;
    this.textures = { dir: this._prefs.texturesDir, numbers };
    return numbers;
  }

  lastIssues(): CheckIssue[] {
    return this.issues;
  }

  setIssues(issues: CheckIssue[]): void {
    this.issues = issues;
  }
}

function validSelection(room: RoomSource, sel: Selection | null): Selection | null {
  if (!sel) return null;
  const n = countOf(room, sel.kind);
  const indices = sel.indices.filter((i) => i < n);
  return indices.length ? { kind: sel.kind, indices } : null;
}

export function countOf(room: RoomSource, kind: ItemKind): number {
  return { vertex: room.vertices.length, linedef: room.linedefs.length, sector: room.sectors.length, thing: room.things.length }[kind];
}

// ---------------------------------------------------------------- files

/** Open a .room.json, or import a .roo, from a path in the rooms folder (or an absolute path). */
export async function openPath(session: Session, path: string): Promise<{ imported: boolean; abs: string }> {
  const abs = resolve(session.roomsDir, path);
  if (/\.roo$/i.test(abs)) {
    const room = importRoo(readRoo(new Uint8Array(await readFile(abs))));
    session.load({ path: null, name: roomName(abs) }, room, null);
    return { imported: true, abs };
  }
  const room = parseRoomFile(await readFile(abs, "utf8"));
  session.load({ path: abs, name: roomName(abs) }, room, room);
  return { imported: false, abs };
}

export async function roomEntries(session: Session): Promise<{ path: string; name: string }[]> {
  return (await listRooms(session.roomsDir)).map((r) => ({ path: r.path, name: r.name }));
}

/** Where compiled rooms go: rooms/out in the repo, or beside the rooms folder. */
export function outDir(session: Session): string {
  return session.repoRoot ? join(session.repoRoot, "rooms", "out") : join(session.roomsDir, "out");
}

/** Kod paths that start with this are new rooms' files, relative to the rooms folder's new/. */
export const NEW_KOD = "new:";

/** rooms/new/*.kod, as Kod source files. */
export async function newRoomKod(roomsDir: string): Promise<{ path: string; text: string }[]> {
  const dir = join(roomsDir, "new");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".kod"));
  } catch {
    return [];
  }
  return Promise.all(names.map(async (n) => ({ path: `${NEW_KOD}${n}`, text: await readFile(join(dir, n), "latin1") })));
}

/** Where a Kod class's file is: in the server's tree, or a new room's. */
export function kodFilePath(session: Session, indexDir: string, path: string): string {
  return path.startsWith(NEW_KOD) ? join(session.roomsDir, "new", path.slice(NEW_KOD.length)) : join(indexDir, path);
}
