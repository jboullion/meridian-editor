// Geometry derived from a room and its compiled BSP: sector polygons in editor
// coordinates (from the BSP leaves, which are convex), and hit testing.

import type { RooFile } from "@meridian-editor/roo";
import type { RoomSource } from "@meridian-editor/roomc";
import type { ItemKind } from "./ops/types.ts";

export interface SectorPiece {
  /** 0-based sector. */
  sector: number;
  /** Flat [x0, y0, x1, y1, ...] in editor units. */
  points: Float64Array;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const piecesCache = new WeakMap<RooFile, SectorPiece[]>();

/** Leaves as editor-space polygons. Client (x, y) → editor (origin.x + x/16, origin.y − y/16). */
export function sectorPieces(file: RooFile, origin: { x: number; y: number }): SectorPiece[] {
  const cached = piecesCache.get(file);
  if (cached) return cached;
  const pieces: SectorPiece[] = [];
  for (const n of file.nodes) {
    if (n.type !== "leaf" || n.sector === 0 || n.points.length < 3) continue;
    const points = new Float64Array(n.points.length * 2);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    n.points.forEach((p, i) => {
      const x = origin.x + p.x / 16;
      const y = origin.y - p.y / 16;
      points[i * 2] = x;
      points[i * 2 + 1] = y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    });
    pieces.push({ sector: n.sector - 1, points, minX, minY, maxX, maxY });
  }
  piecesCache.set(file, pieces);
  return pieces;
}

export function sectorAt(pieces: readonly SectorPiece[], x: number, y: number): number | null {
  for (const p of pieces) {
    if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) continue;
    if (pointInPolygon(p.points, x, y)) return p.sector;
  }
  return null;
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

export function distanceToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/** The item under (x, y) in editor units; `tolerance` is in editor units too. */
export function hitTest(
  room: RoomSource,
  pieces: readonly SectorPiece[] | null,
  x: number,
  y: number,
  tolerance: number,
  showVertices: boolean,
): { kind: ItemKind; index: number } | null {
  let best: { kind: ItemKind; index: number; d: number } | null = null;
  const consider = (kind: ItemKind, index: number, d: number, limit: number): void => {
    if (d <= limit && (!best || d < best.d)) best = { kind, index, d };
  };

  room.things.forEach((t, i) => consider("thing", i, Math.hypot(t.x - x, t.y - y), tolerance * 1.6));
  if (best) return best;
  if (showVertices) {
    room.vertices.forEach(([vx, vy], i) => consider("vertex", i, Math.hypot(vx - x, vy - y), tolerance * 1.2));
    if (best) return best;
  }
  room.linedefs.forEach((l, i) => {
    const a = room.vertices[l.start];
    const b = room.vertices[l.end];
    if (a && b) consider("linedef", i, distanceToSegment(x, y, a[0], a[1], b[0], b[1]), tolerance);
  });
  if (best) return best;
  const sector = pieces ? sectorAt(pieces, x, y) : null;
  return sector === null ? null : { kind: "sector", index: sector };
}

/** The room box (the first two things) in Kod squares: the room's size as Kod counts rows and columns. */
export function roomBoxSize(room: RoomSource): { width: number; height: number } | null {
  const [t0, t1] = room.things;
  if (!t0 || !t1) return null;
  return { width: Math.abs(t1.x - t0.x) / 64, height: Math.abs(t1.y - t0.y) / 64 };
}

/** Everything drawn plus the room box: what Fit frames. Rooms can draw past their box. */
export function roomBounds(room: RoomSource): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of room.vertices) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  for (const t of room.things.slice(0, 2)) {
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x);
    maxY = Math.max(maxY, t.y);
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1024, maxY: 1024 };
  return { minX, minY, maxX, maxY };
}

/** Kod placement for an editor point: 1-based row/col of 64-unit squares from the room box's top-left, plus the fine offset. */
export function kodCoords(room: RoomSource, x: number, y: number): { row: number; col: number; fineRow: number; fineCol: number } | null {
  const [t0, t1] = room.things;
  if (!t0 || !t1) return null;
  const left = Math.min(t0.x, t1.x);
  const top = Math.max(t0.y, t1.y);
  const dx = Math.floor(x) - left;
  const dy = top - Math.floor(y);
  // GetServerCoords (roomedit/source/load.cpp) uses C division, truncating toward zero.
  return { col: 1 + Math.trunc(dx / 64), row: 1 + Math.trunc(dy / 64), fineCol: dx % 64, fineRow: dy % 64 };
}
