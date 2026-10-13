// Where a room's Kod puts things, read from the room classes' source so the
// map can show it. Kod stays the source of truth (ADR 0001 decision 5); this is
// read-only. A room class looks like:
//
//   resources:   room_raza = raza.roo
//   properties:  prRoom = room_raza
//                piRoom_num = RID_RAZA          (RID_* from include/blakston.khd)
//   classvars:   viTeleport_row = 7, viTeleport_col = 2
//   CreateStandardExits():
//      plExits = Cons([ 7, 26, RID_RAZA_INN, 8, 6, ROTATE_NONE ],plExits);
//      plExits = Cons([ 2, 5, ROOM_LOCKED_DOOR, some_message ],plExits);
//      plEdge_Exits = Cons([ LEAVE_NORTH, RID_X, 43, 41, ROTATE_NONE ],plEdge_Exits);
//   CreateStandardObjects():
//      Send(self,@NewHold,#what=Create(&Candle),#new_row=2,#new_col=4,#fine_row=56,#fine_col=40);
//      lObjCoords = [ [06,02,32,56,OO_quiver], [3,4,OO_bench] ];   (CreateOrnObjFromList)
//   plGenerators = [ [38, 39], [41, 29] ];  or  Cons([32,32],plGenerators)
//   plLooping_sounds = [[ fire_sound, 4, 7, 10, 100 ]];
//
// Rows and columns are 1-based Kod squares from the room box's top-left
// corner; fine rows and columns are 0-63 within the square (NewHold defaults
// them to 32, the centre: room.kod NewHold).

export interface KodSourceFile {
  /** Relative to the Kod folder, with forward slashes. */
  path: string;
  text: string;
}

export interface KodPlace {
  row: number;
  col: number;
  fineRow: number;
  fineCol: number;
  /** 1-based line in the class's file. */
  line: number;
}

export interface KodExit extends KodPlace {
  /** The RID constant (or number) it leads to; null for ROOM_LOCKED_DOOR. */
  dest: string | null;
  destRow?: number;
  destCol?: number;
}

export interface KodEdgeExit {
  side: "north" | "south" | "east" | "west";
  dest: string;
  destRow?: number;
  destCol?: number;
  line: number;
}

export interface KodObject extends KodPlace {
  /** Kod class (Candle) or ornament type (OO_quiver); "object" when the code passes a variable. */
  what: string;
  /** The Create(&Class, ...) arguments after the class, as written ("#iColor=LIGHT_FIRE,#iIntensity=30"). */
  args?: string;
}

/** The text inside the parentheses that open at `open` (which must be "("), or null if they don't close. */
function balanced(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

export interface KodRoom {
  className: string;
  /** The class it inherits from (Room, MonsterRoom ...). */
  parent: string;
  path: string;
  roo: string | null;
  /** RID constant name, or the number as written. */
  ridName: string | null;
  rid: number | null;
  teleport: KodPlace | null;
  exits: KodExit[];
  edgeExits: KodEdgeExit[];
  generators: KodPlace[];
  objects: KodObject[];
  sounds: KodObject[];
}

/** RID_NAME = 300 lines from blakston.khd. */
export function parseRids(khd: string): Map<string, number> {
  const rids = new Map<string, number>();
  for (const m of khd.matchAll(/^\s*(RID_\w+)\s*=\s*(\d+)/gm)) rids.set(m[1]!, Number(m[2]));
  return rids;
}

/** Blank out comments, keeping every newline so line numbers still match. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));
}

const HALF = 32;

export function parseKodRoom(file: KodSourceFile, rids: ReadonlyMap<string, number>): KodRoom | null {
  const src = stripComments(file.text);
  const header = /^\s*(\w+)\s+is\s+(\w+)/m.exec(src);
  const className = header?.[1];
  if (!className) return null;
  const parent = header[2]!;
  const lineAt = (index: number): number => {
    let n = 1;
    for (let i = src.indexOf("\n"); i >= 0 && i < index; i = src.indexOf("\n", i + 1)) n++;
    return n;
  };
  const num = (s: string | undefined): number | undefined => (s !== undefined && /^-?\d+$/.test(s.trim()) ? Number(s) : undefined);

  const roos = new Map<string, string>();
  for (const m of src.matchAll(/^\s*(\w+)\s*=\s*([\w-]+\.roo)\b/gim)) roos.set(m[1]!, m[2]!.toLowerCase());
  const prRoom = /\bprRoom\s*=\s*(\w+)/.exec(src)?.[1];
  const roo = (prRoom && roos.get(prRoom)) ?? (roos.size === 1 ? [...roos.values()][0]! : null);
  const ridName = /\bpiRoom_num\s*=\s*(\w+)/.exec(src)?.[1] ?? null;
  const rid = ridName === null ? null : (num(ridName) ?? rids.get(ridName) ?? null);
  if (!roo && rid === null) return null;

  const tRow = /\bviTeleport_row\s*=\s*(\d+)/.exec(src);
  const tCol = /\bviTeleport_col\s*=\s*(\d+)/.exec(src);
  const teleport = tRow && tCol ? { row: Number(tRow[1]), col: Number(tCol[1]), fineRow: HALF, fineCol: HALF, line: lineAt(tRow.index) } : null;

  const exits: KodExit[] = [];
  for (const m of src.matchAll(/\bplExits\s*=\s*Cons\s*\(\s*\[([^\]]*)\]/gi)) {
    const parts = m[1]!.split(",").map((s) => s.trim());
    const row = num(parts[0]);
    const col = num(parts[1]);
    if (row === undefined || col === undefined || !parts[2]) continue;
    const locked = parts[2] === "ROOM_LOCKED_DOOR" || parts[2] === "-1";
    const destRow = locked ? undefined : num(parts[3]);
    const destCol = locked ? undefined : num(parts[4]);
    exits.push({ row, col, fineRow: HALF, fineCol: HALF, line: lineAt(m.index), dest: locked ? null : parts[2], ...(destRow !== undefined && destCol !== undefined ? { destRow, destCol } : {}) });
  }

  const edgeExits: KodEdgeExit[] = [];
  for (const m of src.matchAll(/\bplEdge_Exits\s*=\s*Cons\s*\(\s*\[\s*LEAVE_(NORTH|SOUTH|EAST|WEST)\s*,\s*(\w+)\s*(?:,\s*(\d+)\s*,\s*(\d+))?/gi)) {
    edgeExits.push({
      side: m[1]!.toLowerCase() as KodEdgeExit["side"],
      dest: m[2]!,
      ...(m[3] && m[4] ? { destRow: Number(m[3]), destCol: Number(m[4]) } : {}),
      line: lineAt(m.index),
    });
  }

  // plGenerators = [ [r, c], ... ]; (over several lines) or Cons([r, c], plGenerators)
  const generators: KodPlace[] = [];
  for (const m of src.matchAll(/\bplGenerators\s*=\s*([^;]*);/gi)) {
    const body = m[1]!;
    if (/^\s*\$\s*$/.test(body)) continue;
    const start = m.index + m[0].indexOf(body);
    for (const g of body.matchAll(/\[\s*(\d+)\s*,\s*(\d+)\s*\]/g)) {
      generators.push({ row: Number(g[1]), col: Number(g[2]), fineRow: HALF, fineCol: HALF, line: lineAt(start + g.index) });
    }
  }

  const objects: KodObject[] = [];
  for (const m of src.matchAll(/@NewHold\b([^;]*);/g)) {
    const args = m[1]!;
    const row = num(/#new_row\s*=\s*(-?\d+)\b/.exec(args)?.[1]);
    const col = num(/#new_col\s*=\s*(-?\d+)\b/.exec(args)?.[1]);
    if (row === undefined || col === undefined) continue;
    const create = /#what\s*=\s*Create\s*\(/.exec(args);
    let inside = create ? balanced(args, create.index + create[0].length - 1) : null;
    // #what=oObj: the last "oObj = Create(&Class, ...)" before it.
    const variable = create ? undefined : /#what\s*=\s*([A-Za-z_]\w*)\s*[,)]/.exec(args)?.[1];
    if (variable) {
      const before = src.slice(0, m.index);
      const assigns = [...before.matchAll(new RegExp(`\\b${variable}\\s*=\\s*Create\\s*\\(`, "gi"))];
      const last = assigns[assigns.length - 1];
      if (last) inside = balanced(before, last.index + last[0].length - 1);
    }
    const what = (inside && /^\s*&(\w+)/.exec(inside)?.[1]) ?? "object";
    objects.push({
      row,
      col,
      fineRow: num(/#fine_row\s*=\s*(-?\d+)\b/.exec(args)?.[1]) ?? HALF,
      fineCol: num(/#fine_col\s*=\s*(-?\d+)\b/.exec(args)?.[1]) ?? HALF,
      what,
      ...(inside && inside.includes(",") ? { args: inside.slice(inside.indexOf(",") + 1).trim() } : {}),
      line: lineAt(m.index),
    });
  }
  // Ornament lists for CreateOrnObjFromList: [row, col, OO_X] or [row, col, fine_row, fine_col, OO_X].
  for (const m of src.matchAll(/\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(?:(\d+)\s*,\s*(\d+)\s*,\s*)?(OO_\w+)\s*\]/g)) {
    objects.push({
      row: Number(m[1]),
      col: Number(m[2]),
      fineRow: m[3] ? Number(m[3]) : HALF,
      fineCol: m[4] ? Number(m[4]) : HALF,
      what: m[5]!,
      line: lineAt(m.index),
    });
  }

  const sounds: KodObject[] = [];
  for (const m of src.matchAll(/\bplLooping_sounds\s*=\s*([^;]*);/gi)) {
    const start = m.index + m[0].indexOf(m[1]!);
    for (const s of m[1]!.matchAll(/\[\s*(\w+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,[^\]]*)?\]/g)) {
      sounds.push({ row: Number(s[2]), col: Number(s[3]), fineRow: HALF, fineCol: HALF, what: s[1]!, line: lineAt(start + s.index) });
    }
  }

  return { className, parent, path: file.path, roo, ridName, rid, teleport, exits, edgeExits, generators, objects, sounds };
}

/** Every room class in the Kod tree, by .roo file name (lower case) and by RID. */
export interface KodIndex {
  dir: string;
  /** Several classes can use one .roo (tos.roo: Tos, DeathRealmTos ...); the likeliest first. */
  byRoo: Map<string, KodRoom[]>;
  byRid: Map<number, KodRoom>;
  rids: Map<string, number>;
  /** Every class in the room tree (intermediate ones such as MonsterRoom too): its parent and light properties. */
  classes: Map<string, KodClass>;
  /** Integer constants from blakston.khd (LIGHT_NICE = 164 ...). */
  constants: Map<string, number>;
}

/** A class's own light settings (properties section), as written. */
export interface KodClass {
  parent: string;
  path: string;
  props: Partial<Record<LightProp, { expr: string; line: number }>>;
  /** The file's own constants section (BASE_LIGHT = LIGHT_NICE), as written. */
  constants: [string, string][];
}

const LIGHT_PROPS = ["piBaseLight", "piOutside_factor", "piDirectional_percent"] as const;
type LightProp = (typeof LIGHT_PROPS)[number];

/** Every NAME = 123 (or 0x7F) in a .khd, by upper-case name: Kod doesn't care about case. */
export function parseConstants(khd: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of khd.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(-?(?:0x[0-9a-f]+|\d+))\b/gim)) out.set(m[1]!.toUpperCase(), Number(m[2]));
  return out;
}

function parseClass(file: KodSourceFile): [string, KodClass] | null {
  const src = stripComments(file.text);
  const header = /^\s*(\w+)\s+is\s+(\w+)/m.exec(src);
  if (!header) return null;
  // Only the properties section: messages change these at run time (piBaseLight = piBaseLight + amount).
  const start = src.search(/^\s*properties:/m);
  const end = src.search(/^\s*messages:/m);
  const props: KodClass["props"] = {};
  if (start >= 0) {
    const section = src.slice(start, end > start ? end : undefined);
    for (const name of LIGHT_PROPS) {
      const m = new RegExp(`^\\s*${name}\\s*=\\s*([^\\r\\n]+)`, "m").exec(section);
      if (m) props[name] = { expr: m[1]!.trim(), line: src.slice(0, start + m.index + m[0].indexOf(name)).split("\n").length };
    }
  }
  const constants: [string, string][] = [];
  const cStart = src.search(/^\s*constants:/m);
  if (cStart >= 0) {
    const rest = src.slice(cStart).replace(/^\s*constants:/, "");
    const cEnd = rest.search(/^\s*(resources|classvars|properties|messages):/m);
    for (const m of (cEnd >= 0 ? rest.slice(0, cEnd) : rest).matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*([^\r\n]+)/gm)) constants.push([m[1]!, m[2]!.trim()]);
  }
  return [header[1]!, { parent: header[2]!, path: file.path, props, constants }];
}

/**
 * Evaluate a Kod integer expression of constants (upper-case keys): | & + - * /
 * and parentheses, C division. Null if it isn't one.
 */
export function evalKodInt(expr: string, constants: ReadonlyMap<string, number>): number | null {
  const tokens = expr.match(/0x[0-9a-f]+|\d+|[A-Za-z_]\w*|[-+*/()|&]/gi);
  if (!tokens || tokens.join("") !== expr.replace(/\s+/g, "")) return null;
  let i = 0;
  const atom = (): number | null => {
    const t = tokens[i++];
    if (t === undefined) return null;
    if (t === "(") {
      const v = bits();
      return tokens[i++] === ")" ? v : null;
    }
    if (t === "-") {
      const v = atom();
      return v === null ? null : -v;
    }
    if (/^(0x[0-9a-f]+|\d+)$/i.test(t)) return Number(t);
    return constants.get(t.toUpperCase()) ?? null;
  };
  const product = (): number | null => {
    let v = atom();
    while (v !== null && (tokens[i] === "*" || tokens[i] === "/")) {
      const op = tokens[i++];
      const r = atom();
      if (r === null || (op === "/" && r === 0)) return null;
      v = op === "*" ? v * r : Math.trunc(v / r);
    }
    return v;
  };
  const sum = (): number | null => {
    let v = product();
    while (v !== null && (tokens[i] === "+" || tokens[i] === "-")) {
      const op = tokens[i++];
      const r = product();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const bits = (): number | null => {
    let v = sum();
    while (v !== null && (tokens[i] === "|" || tokens[i] === "&")) {
      const op = tokens[i++];
      const r = sum();
      if (r === null) return null;
      v = op === "|" ? v | r : v & r;
    }
    return v;
  };
  const v = bits();
  return i === tokens.length ? v : null;
}

/** room.kod's own values, for classes that don't set them. */
const ROOM_DEFAULTS: Record<LightProp, string> = { piBaseLight: "LIGHT_MAX", piOutside_factor: "OUTDOORS_COMPLETE", piDirectional_percent: "0" };

export interface KodRoomLight {
  baseLight: number;
  outsideFactor: number;
  directionalPercent: number;
  /** Where each came from: "LIGHT_NICE (tosrm/tos.kod:40)", or "Room default". */
  sources: Record<"baseLight" | "outsideFactor" | "directionalPercent", string>;
}

/** A room class's light properties, following its parents up to Room. */
export function kodRoomLight(index: KodIndex, k: KodRoom): KodRoomLight {
  const find = (prop: LightProp): [number, string] => {
    const seen = new Set<string>();
    for (let name: string | undefined = k.className; name && !seen.has(name); name = index.classes.get(name)?.parent) {
      seen.add(name);
      const c = index.classes.get(name);
      const p = c?.props[prop];
      if (p) {
        // The file's own constants first, then blakston.khd's.
        const scope = new Map(index.constants);
        for (const [name, expr] of c!.constants) {
          const v = evalKodInt(expr, scope);
          if (v !== null) scope.set(name.toUpperCase(), v);
        }
        const v = evalKodInt(p.expr, scope);
        if (v !== null) return [v, `${p.expr} (${c!.path}:${p.line})`];
      }
    }
    const d = ROOM_DEFAULTS[prop];
    return [evalKodInt(d, index.constants) ?? 0, `${d} (Room's default)`];
  };
  const [baseLight, b] = find("piBaseLight");
  const [outsideFactor, o] = find("piOutside_factor");
  const [directionalPercent, d] = find("piDirectional_percent");
  return { baseLight, outsideFactor, directionalPercent, sources: { baseLight: b, outsideFactor: o, directionalPercent: d } };
}

export function buildKodIndex(dir: string, files: readonly KodSourceFile[], khd: string): KodIndex {
  const rids = parseRids(khd);
  const constants = parseConstants(khd);
  const classes = new Map<string, KodClass>();
  const byRoo = new Map<string, KodRoom[]>();
  const byRid = new Map<number, KodRoom>();
  for (const f of files) {
    const c = parseClass(f);
    if (c && !classes.has(c[0])) classes.set(c[0], c[1]);
    const room = parseKodRoom(f, rids);
    if (!room) continue;
    if (room.roo) byRoo.set(room.roo, [...(byRoo.get(room.roo) ?? []), room]);
    if (room.rid !== null && !byRid.has(room.rid)) byRid.set(room.rid, room);
  }
  // The class in a file named after the room (tosrm/tos.kod for tos.roo), then the one placing the most.
  const named = (r: KodRoom): number => (r.path.split("/").pop()!.replace(/\.kod$/i, "").toLowerCase() === r.roo!.replace(/\.roo$/, "") ? 1 : 0);
  const placed = (r: KodRoom): number => r.exits.length + r.edgeExits.length + r.generators.length + r.objects.length;
  for (const list of byRoo.values()) list.sort((a, b) => named(b) - named(a) || placed(b) - placed(a));
  return { dir, byRoo, byRid, rids, classes, constants };
}

/** The classes that could be a room's: by RID when it has one, else by its .roo file name (from the source's name). */
export function kodCandidates(index: KodIndex, docName: string | undefined, roomId: number): KodRoom[] {
  const roo = docName?.replace(/\.room\.json$|\.roo$|\.json$/i, "").toLowerCase();
  const list = (roo && index.byRoo.get(`${roo}.roo`)) || [];
  const byRid = roomId ? index.byRid.get(roomId) : undefined;
  return byRid ? [byRid, ...list.filter((r) => r !== byRid)] : list;
}

/** Editor coordinates of a Kod spot, from the room box (things 0 and 1). */
export function kodToEditor(box: { left: number; top: number }, p: { row: number; col: number; fineRow: number; fineCol: number }): [number, number] {
  return [box.left + (p.col - 1) * 64 + p.fineCol, box.top - ((p.row - 1) * 64 + p.fineRow)];
}

/** The room box's top-left in editor units, which Kod rows and columns count from. */
export function roomBox(things: readonly { x: number; y: number }[]): { left: number; top: number } | null {
  const [t0, t1] = things;
  return t0 && t1 ? { left: Math.min(t0.x, t1.x), top: Math.max(t0.y, t1.y) } : null;
}

export type KodMark = {
  kind: "exit" | "locked" | "generator" | "object" | "sound" | "arrival";
  x: number;
  y: number;
  label: string;
  line: number;
  row: number;
  col: number;
};

/** Every placement of a class, in editor coordinates. */
export function kodMarks(k: KodRoom, box: { left: number; top: number }): KodMark[] {
  const out: KodMark[] = [];
  const at = (p: { row: number; col: number; fineRow: number; fineCol: number }): [number, number] => kodToEditor(box, p);
  if (k.teleport) {
    const [x, y] = at(k.teleport);
    out.push({ kind: "arrival", x, y, label: "arrival (teleport)", line: k.teleport.line, row: k.teleport.row, col: k.teleport.col });
  }
  for (const e of k.exits) {
    const [x, y] = at(e);
    const to = e.dest === null ? "locked door" : `exit to ${e.dest}${e.destRow !== undefined ? ` (${e.destRow}, ${e.destCol})` : ""}`;
    out.push({ kind: e.dest === null ? "locked" : "exit", x, y, label: to, line: e.line, row: e.row, col: e.col });
  }
  for (const g of k.generators) {
    const [x, y] = at(g);
    out.push({ kind: "generator", x, y, label: "monster generator", line: g.line, row: g.row, col: g.col });
  }
  for (const o of k.objects) {
    const [x, y] = at(o);
    out.push({ kind: "object", x, y, label: o.what, line: o.line, row: o.row, col: o.col });
  }
  for (const s of k.sounds) {
    const [x, y] = at(s);
    out.push({ kind: "sound", x, y, label: `sound ${s.what}`, line: s.line, row: s.row, col: s.col });
  }
  return out;
}
