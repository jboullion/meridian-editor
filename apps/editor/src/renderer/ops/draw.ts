// Drawing: add vertices and linedefs along a path, splitting what they cross,
// then work out sectors for the faces the new lines close. This is roomedit's
// "add LineDefs between vertices" plus "add Sector" and SplitSector, done in
// one step the way modern map editors draw.

import type { RoomSource, SourceLinedef, SourceSector, SourceSide } from "@meridian-editor/roomc";
import { WF } from "@meridian-editor/roo";
import {
  adjacency,
  findLinedef,
  findVertex,
  heKey,
  lineLength,
  nearestOnSegment,
  pointBeside,
  sectorAtPoint,
  segmentIntersection,
  sideOf,
  traceFace,
  type Face,
  type HalfEdge,
  type Pt,
} from "./geom.ts";

/** What new sectors and sides start as (roomedit's Default* settings). */
export interface DrawDefaults {
  floorHeight: number;
  ceilingHeight: number;
  floorTexture: number;
  ceilingTexture: number;
  light: number;
  wallTexture: number;
  upperTexture: number;
  lowerTexture: number;
  /**
   * Set WF_PASSABLE on both sides of walls that drawing makes two-sided.
   * roomedit leaves it off, but Server 104 and the client block walking
   * through any wall side without it (s:blakserv/roofile.c:101).
   */
  passable: boolean;
}

export const ROOMEDIT_DEFAULTS: DrawDefaults = {
  floorHeight: 0,
  ceilingHeight: 64,
  floorTexture: 0,
  ceilingTexture: 0,
  light: 128,
  wallTexture: 0,
  upperTexture: 0,
  lowerTexture: 0,
  passable: true,
};

export function newSector(d: DrawDefaults): SourceSector {
  return {
    serverId: 0,
    floorTexture: d.floorTexture,
    ceilingTexture: d.ceilingTexture,
    floorHeight: d.floorHeight,
    ceilingHeight: d.ceilingHeight,
    xOffset: 0,
    yOffset: 0,
    light: d.light,
    flags: 0,
    animateSpeed: 0,
    floorSlope: null,
    ceilingSlope: null,
  };
}

export function newSide(sector: number, d: DrawDefaults): SourceSide {
  return { sector, normal: d.wallTexture, above: d.upperTexture, below: d.lowerTexture, xOffset: 0, yOffset: 0, serverId: 0, animateSpeed: 0, flags: 0 };
}

/** A mutable working copy: edits append, so existing indices stay valid. */
interface Work {
  vertices: [number, number][];
  linedefs: SourceLinedef[];
}

function work(room: RoomSource): Work {
  return { vertices: room.vertices.slice(), linedefs: room.linedefs.slice() };
}

function vertexAt(w: Work, x: number, y: number): number {
  const i = w.vertices.findIndex(([vx, vy]) => vx === x && vy === y);
  if (i >= 0) return i;
  w.vertices.push([x, y]);
  return w.vertices.length - 1;
}

/**
 * Split linedef `index` at vertex `v`. The original keeps start→v, a new
 * linedef takes v→end; side offsets carry on so textures don't jump.
 */
export function splitLinedefAt(w: Work, index: number, v: number): number {
  const l = w.linedefs[index]!;
  const a = w.vertices[l.start]!;
  const m = w.vertices[v]!;
  const b = w.vertices[l.end]!;
  const first = Math.round(Math.hypot(m[0] - a[0], m[1] - a[1]));
  const second = Math.round(Math.hypot(b[0] - m[0], b[1] - m[1]));
  w.linedefs[index] = { ...l, end: v, back: l.back && { ...l.back, xOffset: l.back.xOffset + second } };
  w.linedefs.push({ ...l, start: v, front: l.front && { ...l.front, xOffset: l.front.xOffset + first }, back: l.back && { ...l.back } });
  return w.linedefs.length - 1;
}

/** Put a vertex at p: reuse one there, or split a linedef p lies on. */
function placeVertex(w: Work, p: Pt): number {
  const existing = w.vertices.findIndex(([vx, vy]) => vx === p[0] && vy === p[1]);
  if (existing >= 0) return existing;
  const v = vertexAt(w, p[0], p[1]);
  for (let i = 0; i < w.linedefs.length; i++) {
    const l = w.linedefs[i]!;
    if (l.start === v || l.end === v) continue;
    const near = nearestOnSegment(p, w.vertices[l.start]!, w.vertices[l.end]!);
    if (near.d < 0.5 && near.t > 0 && near.t < 1) {
      splitLinedefAt(w, i, v);
      break;
    }
  }
  return v;
}

export interface InsertResult {
  room: RoomSource;
  /** Linedefs along the path (new or reused), in path order. */
  path: number[];
  /** Linedefs created. */
  created: number[];
  /** Sectors created. */
  sectors: number[];
}

/**
 * Add the polyline `points` (closed if `closed`), splitting crossed linedefs,
 * then assign sectors to the faces it closes.
 */
export function insertPath(room: RoomSource, points: readonly Pt[], closed: boolean, defaults: DrawDefaults): InsertResult {
  const pts = points.map(([x, y]) => [Math.round(x), Math.round(y)] as const).filter((p, i, a) => i === 0 || p[0] !== a[i - 1]![0] || p[1] !== a[i - 1]![1]);
  if (closed && pts.length > 2 && pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1]) pts.pop();
  if (pts.length < 2) return { room, path: [], created: [], sectors: [] };

  const w = work(room);
  const verts = pts.map((p) => placeVertex(w, p));
  const segments: [number, number][] = [];
  for (let i = 0; i + 1 < verts.length; i++) segments.push([verts[i]!, verts[i + 1]!]);
  if (closed && verts.length > 2) segments.push([verts[verts.length - 1]!, verts[0]!]);

  const path: number[] = [];
  const created: number[] = [];
  for (const [va, vb] of segments) {
    // Split this segment and the linedefs it crosses at their intersections.
    const a = w.vertices[va]!;
    const b = w.vertices[vb]!;
    const cuts: { t: number; v: number }[] = [];
    const count = w.linedefs.length;
    for (let i = 0; i < count; i++) {
      const l = w.linedefs[i]!;
      if (l.start === va || l.end === va || l.start === vb || l.end === vb) continue;
      const hit = segmentIntersection(a, b, w.vertices[l.start]!, w.vertices[l.end]!);
      if (!hit) continue;
      const x = Math.round(a[0] + (b[0] - a[0]) * hit.t);
      const y = Math.round(a[1] + (b[1] - a[1]) * hit.t);
      const v = vertexAt(w, x, y);
      if (v !== w.linedefs[i]!.start && v !== w.linedefs[i]!.end) splitLinedefAt(w, i, v);
      cuts.push({ t: hit.t, v });
    }
    // Vertices already lying on the segment become stops too.
    w.vertices.forEach((p, v) => {
      if (v === va || v === vb || cuts.some((c) => c.v === v)) return;
      const near = nearestOnSegment(p, a, b);
      if (near.d < 0.5 && near.t > 0 && near.t < 1) cuts.push({ t: near.t, v });
    });
    cuts.sort((x, y) => x.t - y.t);
    const stops = [va, ...cuts.map((c) => c.v), vb].filter((v, i, s) => i === 0 || v !== s[i - 1]);
    for (let i = 0; i + 1 < stops.length; i++) {
      const s = stops[i]!;
      const e = stops[i + 1]!;
      const existing = w.linedefs.findIndex((l) => (l.start === s && l.end === e) || (l.start === e && l.end === s));
      if (existing >= 0) {
        path.push(existing);
        continue;
      }
      w.linedefs.push({ start: s, end: e, front: null, back: null });
      path.push(w.linedefs.length - 1);
      created.push(w.linedefs.length - 1);
    }
  }

  const drawn: RoomSource = { ...room, vertices: w.vertices, linedefs: w.linedefs };
  const assigned = assignSectors(room, drawn, created, defaults);
  return { room: assigned.room, path, created, sectors: assigned.sectors };
}

/**
 * Give the faces around `created` linedefs their sectors.
 *  - A closed face that was empty space gets a new sector.
 *  - A face cut out of sector X: the piece that still has X's old walls and is
 *    largest keeps X; every other piece gets a copy of X.
 *  - The outside of a loop (a hole in X) faces X.
 * New sides are made as needed; two-sided lines lose their normal texture.
 */
export function assignSectors(
  before: RoomSource,
  drawn: RoomSource,
  created: readonly number[],
  defaults: DrawDefaults,
): { room: RoomSource; sectors: number[] } {
  if (created.length === 0) return { room: drawn, sectors: [] };
  const adj = adjacency(drawn);
  const isNew = new Set(created);
  const seen = new Set<string>();
  const bounded: { face: Face; prior: number | null; keepsOld: boolean }[] = [];
  const holes: { face: Face; prior: number | null }[] = [];

  for (const li of created) {
    for (const front of [true, false]) {
      const start: HalfEdge = { line: li, front };
      if (seen.has(heKey(start))) continue;
      const face = traceFace(drawn, adj, start);
      if (!face) continue;
      for (const h of face.edges) seen.add(heKey(h));
      const prior = priorSector(before, drawn, face, isNew);
      if (face.area < 0) {
        const keepsOld = prior !== null && face.edges.some((h) => !isNew.has(h.line) && sideOf(drawn.linedefs[h.line]!, h.front)?.sector === prior);
        bounded.push({ face, prior, keepsOld });
      } else {
        holes.push({ face, prior });
      }
    }
  }

  const linedefs = drawn.linedefs.slice();
  const sectors = drawn.sectors.slice();
  const made: number[] = [];

  // Which face keeps each old sector. When the outside of a loop faces X, X
  // carries on out there (a shape drawn against an island, such as a ramp up
  // to a ledge), so no piece inside the loop keeps it.
  const heldOutside = new Set(holes.map((h) => h.prior));
  const keeper = new Map<number, (typeof bounded)[number]>();
  for (const b of bounded) {
    if (b.prior === null || !b.keepsOld || heldOutside.has(b.prior)) continue;
    const current = keeper.get(b.prior);
    if (!current || Math.abs(b.face.area) > Math.abs(current.face.area)) keeper.set(b.prior, b);
  }

  const setSide = (h: HalfEdge, sector: number): void => {
    const l = linedefs[h.line]!;
    const key = h.front ? "front" : "back";
    const side = l[key];
    if (side) {
      if (side.sector !== sector) linedefs[h.line] = { ...l, [key]: { ...side, sector } };
    } else {
      // Borrow the look of the other side if there is one.
      const other = h.front ? l.back : l.front;
      linedefs[h.line] = { ...l, [key]: other ? { ...other, sector, xOffset: 0, yOffset: 0 } : newSide(sector, defaults) };
    }
  };

  for (const b of bounded) {
    let sector: number;
    if (b.prior !== null && keeper.get(b.prior) === b) sector = b.prior;
    else {
      sectors.push(b.prior !== null ? { ...sectors[b.prior]!, floorSlope: null, ceilingSlope: null, flags: sectors[b.prior]!.flags & ~0xc00 } : newSector(defaults));
      sector = sectors.length - 1;
      made.push(sector);
    }
    for (const h of b.face.edges) {
      // Old sides only move if they faced the sector being cut (or nothing).
      // Anything else is shipped-data overlap — such as two linedefs between
      // the same vertices — that the walk can't tell apart; leave it alone.
      const existing = sideOf(linedefs[h.line]!, h.front);
      if (!isNew.has(h.line) && existing && existing.sector >= 0 && existing.sector !== b.prior) continue;
      setSide(h, sector);
    }
  }
  for (const hole of holes) {
    if (hole.prior === null) continue;
    for (const h of hole.face.edges) if (isNew.has(h.line)) setSide(h, hole.prior);
  }

  // Islands: sides inside a piece cut out of X (a pillar, the outside of an
  // inner room) still face X. Point them at the smallest piece of X that now
  // contains them.
  const pieces = new Map<number, { polygon: Float64Array; area: number; sector: number }[]>();
  for (const b of bounded) {
    if (b.prior === null) continue;
    const sector = keeper.get(b.prior) === b ? b.prior : linedefsSectorOf(linedefs, b.face.edges[0]!);
    const list = pieces.get(b.prior) ?? [];
    list.push({ polygon: facePolygon(drawn, b.face), area: Math.abs(b.face.area), sector });
    pieces.set(b.prior, list);
  }
  for (const [prior, list] of pieces) {
    if (list.every((p) => p.sector === prior)) continue;
    list.sort((a, b) => a.area - b.area);
    const current: RoomSource = { ...drawn, linedefs };
    linedefs.forEach((l, li) => {
      for (const front of [true, false]) {
        const side = front ? l.front : l.back;
        if (!side || side.sector !== prior) continue;
        const [px, py] = pointBeside(current, { line: li, front }, 0.25);
        const piece = list.find((p) => pointInPolygon(p.polygon, px, py));
        if (piece && piece.sector !== prior) setSide({ line: li, front }, piece.sector);
      }
    });
  }

  // Tidy the lines that changed: front side first, and the normal texture
  // only on one-sided walls.
  const touched = new Set<number>([...created, ...bounded.flatMap((b) => b.face.edges.map((h) => h.line))]);
  for (const li of touched) {
    let l = linedefs[li]!;
    if (!l.front && l.back) l = { start: l.end, end: l.start, front: l.back, back: null };
    const wasTwoSided = !!(drawn.linedefs[li]!.front && drawn.linedefs[li]!.back);
    const pass = defaults.passable ? WF.PASSABLE : 0;
    if (l.front && l.back && isNew.has(li)) {
      l = {
        ...l,
        front: { ...l.front, normal: 0, above: l.front.above || defaults.upperTexture, below: l.front.below || defaults.lowerTexture, flags: l.front.flags | pass },
        back: { ...l.back, normal: 0, above: l.back.above || defaults.upperTexture, below: l.back.below || defaults.lowerTexture, flags: l.back.flags | pass },
      };
    } else if (l.front && l.back && !wasTwoSided) {
      // An old one-sided wall became two-sided: its wall texture moves to the step faces.
      const tex = l.front.normal || l.back.normal;
      l = {
        ...l,
        front: { ...l.front, normal: 0, above: l.front.above || tex, below: l.front.below || tex, flags: l.front.flags | pass },
        back: { ...l.back, normal: 0, above: l.back.above || tex, below: l.back.below || tex, flags: l.back.flags | pass },
      };
    }
    linedefs[li] = l;
  }

  return { room: { ...drawn, linedefs, sectors }, sectors: made };
}

/**
 * What a face was part of before the drawing. The old walls around it say
 * best (they all face the same sector when the room is consistent); a face of
 * only new lines is sampled just inside one of them.
 */
function priorSector(before: RoomSource, drawn: RoomSource, face: Face, isNew: ReadonlySet<number>): number | null {
  const votes = new Map<number, number>();
  // Only a bounded face can trust its walls: an outer boundary runs round
  // everything a new line happens to connect.
  for (const h of face.area < 0 ? face.edges : []) {
    if (isNew.has(h.line)) continue;
    const side = sideOf(drawn.linedefs[h.line]!, h.front);
    if (side && side.sector >= 0) votes.set(side.sector, (votes.get(side.sector) ?? 0) + 1);
  }
  if (votes.size > 0) return [...votes].sort((a, b) => b[1] - a[1])[0]![0];
  if (face.edges.some((h) => !isNew.has(h.line)) && face.area < 0) {
    // Old walls that faced nothing: this was empty space.
    return null;
  }
  const polygon = facePolygon(drawn, face);
  const probe = face.edges.find((h) => isNew.has(h.line)) ?? face.edges[0]!;
  for (const distance of [0.5, 0.1, 0.01]) {
    const [px, py] = pointBeside(drawn, probe, distance);
    if (face.area >= 0 || pointInPolygon(polygon, px, py)) return sectorAtPoint(before, px, py);
  }
  const [px, py] = pointBeside(drawn, probe, 0.01);
  return sectorAtPoint(before, px, py);
}

function linedefsSectorOf(linedefs: readonly SourceLinedef[], h: HalfEdge): number {
  return (h.front ? linedefs[h.line]!.front : linedefs[h.line]!.back)?.sector ?? -1;
}

function facePolygon(room: RoomSource, face: Face): Float64Array {
  const pts = new Float64Array(face.edges.length * 2);
  face.edges.forEach((h, i) => {
    const l = room.linedefs[h.line]!;
    const v = room.vertices[h.front ? l.start : l.end]!;
    pts[i * 2] = v[0];
    pts[i * 2 + 1] = v[1];
  });
  return pts;
}

function pointInPolygon(pts: Float64Array, x: number, y: number): boolean {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2]!;
    const yi = pts[i * 2 + 1]!;
    const xj = pts[j * 2]!;
    const yj = pts[j * 2 + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Split sector between two vertices by drawing a linedef between them (roomedit SplitSector). */
export function connectVertices(room: RoomSource, v1: number, v2: number, defaults: DrawDefaults): InsertResult {
  return insertPath(room, [room.vertices[v1]!, room.vertices[v2]!], false, defaults);
}

/** Split two linedefs at their midpoints and join them (roomedit SplitLineDefsAndSector). */
export function splitLinedefsAndSector(room: RoomSource, l1: number, l2: number, defaults: DrawDefaults): InsertResult {
  const mid = (li: number): Pt => {
    const l = room.linedefs[li]!;
    const a = room.vertices[l.start]!;
    const b = room.vertices[l.end]!;
    return [Math.trunc((a[0] + b[0]) / 2), Math.trunc((a[1] + b[1]) / 2)];
  };
  return insertPath(room, [mid(l1), mid(l2)], false, defaults);
}

export { findLinedef, findVertex, lineLength };
