// Planar-graph helpers over a room source: which sector a point is in, the
// faces around linedef sides, splitting linedefs. Editor units, y up; a
// linedef's front (+) side is on its right going from start to end.

import type { RoomSource, SourceLinedef, SourceSide } from "@meridian-editor/roomc";

export type Pt = readonly [number, number];

/** > 0 when p is left of a→b, < 0 when right (y up). */
export function cross(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

/**
 * The sector containing (x, y): cast a ray towards +x, take the nearest
 * linedef it crosses, and use that linedef's side facing the point (the way
 * roomedit's GetOppositeSector finds the sector across a gap).
 */
export function sectorAtPoint(room: RoomSource, x: number, y: number): number | null {
  // A ray through a vertex can't tell which of the walls meeting there it
  // crossed. Vertices are whole numbers, so cast just off any whole y.
  if (Number.isInteger(y * 2)) y += 0.000123;
  let best = Infinity;
  let hit: { line: SourceLinedef; side: number } | null = null;
  for (const l of room.linedefs) {
    const a = room.vertices[l.start];
    const b = room.vertices[l.end];
    if (!a || !b || a[1] > y === b[1] > y) continue;
    const ix = a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
    if (ix > x && ix < best) {
      best = ix;
      hit = { line: l, side: cross(a[0], a[1], b[0], b[1], x, y) };
    }
  }
  if (!hit) return null;
  // Right of the line is the front.
  const side = hit.side < 0 ? hit.line.front : hit.line.back;
  return side && side.sector >= 0 ? side.sector : null;
}

/** One side of a linedef, walked with that side on the right. */
export interface HalfEdge {
  line: number;
  front: boolean;
}

export const heKey = (h: HalfEdge): string => `${h.line}${h.front ? "+" : "-"}`;

export function halfEdgeEnds(room: RoomSource, h: HalfEdge): [number, number] {
  const l = room.linedefs[h.line]!;
  return h.front ? [l.start, l.end] : [l.end, l.start];
}

/** Linedefs touching each vertex. */
export function adjacency(room: RoomSource): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  room.linedefs.forEach((l, i) => {
    if (l.start === l.end) return;
    for (const v of [l.start, l.end]) {
      let list = adj.get(v);
      if (!list) adj.set(v, (list = []));
      list.push(i);
    }
  });
  return adj;
}

export interface Face {
  edges: HalfEdge[];
  /** Shoelace area of the walk. Negative: a bounded face (walked clockwise). Positive: an outer boundary or a hole. */
  area: number;
}

/**
 * Walk the face on the right of `start`, always taking the sharpest right turn:
 * at each vertex, the next edge is the first one counter-clockwise from the
 * edge we arrived along (seen from the vertex, pointing back).
 */
export function traceFace(room: RoomSource, adj: Map<number, number[]>, start: HalfEdge): Face | null {
  const edges: HalfEdge[] = [];
  let area = 0;
  let h = start;
  const limit = room.linedefs.length * 2 + 2;
  for (let step = 0; step < limit; step++) {
    edges.push(h);
    const [u, v] = halfEdgeEnds(room, h);
    const pu = room.vertices[u]!;
    const pv = room.vertices[v]!;
    area += pu[0] * pv[1] - pv[0] * pu[1];

    const back = Math.atan2(pu[1] - pv[1], pu[0] - pv[0]);
    let best: HalfEdge | null = null;
    let bestTurn = Infinity;
    for (const li of adj.get(v) ?? []) {
      const l = room.linedefs[li]!;
      const w = l.start === v ? l.end : l.start;
      const pw = room.vertices[w]!;
      if (pw[0] === pv[0] && pw[1] === pv[1]) continue;
      let turn = Math.atan2(pw[1] - pv[1], pw[0] - pv[0]) - back;
      while (turn <= 1e-12) turn += Math.PI * 2;
      while (turn > Math.PI * 2 + 1e-12) turn -= Math.PI * 2;
      // Going straight back the way we came is the last resort (a dead end).
      if (li === h.line) turn = Math.PI * 2 + 1;
      if (turn < bestTurn) {
        bestTurn = turn;
        best = { line: li, front: l.start === v };
      }
    }
    if (!best) return null;
    if (best.line === start.line && best.front === start.front) return { edges, area: area / 2 };
    h = best;
  }
  return null;
}

/** A point just inside the face on the right of a half-edge, by its midpoint. */
export function pointBeside(room: RoomSource, h: HalfEdge, distance = 0.5): [number, number] {
  const [u, v] = halfEdgeEnds(room, h);
  const a = room.vertices[u]!;
  const b = room.vertices[v]!;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  // Right of a→b in y-up coordinates is (dy, -dx).
  return [(a[0] + b[0]) / 2 + (dy / len) * distance, (a[1] + b[1]) / 2 - (dx / len) * distance];
}

export function sideOf(l: SourceLinedef, front: boolean): SourceSide | null {
  return front ? l.front : l.back;
}

export function lineLength(room: RoomSource, l: SourceLinedef): number {
  const a = room.vertices[l.start]!;
  const b = room.vertices[l.end]!;
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Where segments p→q and a→b cross, as t along p→q (0..1, exclusive of the ends) and u along a→b. */
export function segmentIntersection(p: Pt, q: Pt, a: Pt, b: Pt): { t: number; u: number } | null {
  const rx = q[0] - p[0];
  const ry = q[1] - p[1];
  const sx = b[0] - a[0];
  const sy = b[1] - a[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((a[0] - p[0]) * sy - (a[1] - p[1]) * sx) / denom;
  const u = ((a[0] - p[0]) * ry - (a[1] - p[1]) * rx) / denom;
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null;
  return { t, u };
}

/** Distance from p to segment a→b and the parameter of the nearest point. */
export function nearestOnSegment(p: Pt, a: Pt, b: Pt): { d: number; t: number; x: number; y: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return { d: Math.hypot(p[0] - x, p[1] - y), t, x, y };
}

export function findVertex(room: RoomSource, x: number, y: number): number {
  return room.vertices.findIndex(([vx, vy]) => vx === x && vy === y);
}

export function findLinedef(room: RoomSource, a: number, b: number): number {
  return room.linedefs.findIndex((l) => (l.start === a && l.end === b) || (l.start === b && l.end === a));
}
