// roomedit's "Insert standard object": rectangle, N-sided polygon, circle and
// the Meridian wall torch. Shapes go in through insertPath, so drawn in empty
// space they make a new sector and drawn inside one they make an inner
// sector — or, as `pillar`, a solid column (roomedit's behaviour inside a sector).

import { WF } from "@meridian-editor/roo";
import type { RoomSource, SourceSide } from "@meridian-editor/roomc";
import { insertPath, splitLinedefAt, type DrawDefaults, type InsertResult } from "./draw.ts";
import { deleteItems } from "./edit.ts";
import { nearestOnSegment, sectorAtPoint, type Pt } from "./geom.ts";
import { OpError } from "./types.ts";

export function rectanglePoints(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const bottom = Math.min(y0, y1);
  const top = Math.max(y0, y1);
  // Clockwise (y up), so the fronts face in.
  return [
    [left, bottom],
    [left, top],
    [right, top],
    [right, bottom],
  ];
}

/** roomedit InsertPolygonVertices: n points on a circle, starting east, turning counter-clockwise. */
export function polygonPoints(cx: number, cy: number, sides: number, radius: number): Pt[] {
  const n = Math.max(3, Math.trunc(sides));
  const theta = (Math.PI * 2) / n;
  const tangential = Math.tan(theta);
  const radial = Math.cos(theta);
  let x = Math.max(8, radius);
  let y = 0;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    pts.push([cx + Math.round(x), cy + Math.round(y)]);
    const tx = -y;
    const ty = x;
    x += tx * tangential;
    y += ty * tangential;
    x *= radial;
    y *= radial;
  }
  // Counter-clockwise from roomedit; reverse so fronts face in.
  return pts.reverse();
}

/** roomedit InsertCircle: the side count grows with the radius. */
export function circleSides(radius: number): number {
  return Math.trunc(9.8 * Math.sqrt(Math.max(8, radius)));
}

export function insertShape(room: RoomSource, points: readonly Pt[], defaults: DrawDefaults, pillar = false): InsertResult {
  const result = insertPath(room, points, true, defaults);
  if (!pillar || result.sectors.length === 0) return result;
  // A pillar: drop the inner sector so its walls face out into the surrounding one.
  const inner = result.sectors.filter((s) => {
    const sec = result.room.sectors[s];
    return sec !== undefined;
  });
  const holed = result.room.linedefs.some((l, i) => result.path.includes(i) && l.front && l.back);
  if (!holed) throw new OpError("A pillar has to be drawn inside a sector.");
  const solid = deleteItems(result.room, "sector", inner);
  // Its walls are one-sided now: solid, with the wall texture (drawing gave them step textures).
  const linedefs = solid.linedefs.map((l) => {
    const side = l.front && !l.back ? l.front : null;
    if (!side || side.normal) return l;
    const along = result.room.vertices;
    const onPath = result.path.some((i) => {
      const p = result.room.linedefs[i]!;
      const [a, b] = [along[p.start]!, along[p.end]!];
      const [c, d] = [solid.vertices[l.start]!, solid.vertices[l.end]!];
      return (a[0] === c[0] && a[1] === c[1] && b[0] === d[0] && b[1] === d[1]) || (a[0] === d[0] && a[1] === d[1] && b[0] === c[0] && b[1] === c[1]);
    });
    if (!onPath) return l;
    return { ...l, front: { ...side, normal: defaults.wallTexture || side.above || side.below, flags: side.flags & ~WF.PASSABLE } };
  });
  return { ...result, room: { ...solid, linedefs }, sectors: [] };
}

// Meridian's torch: two crossed animated textures on four short two-sided linedefs (roomedit InsertTorch).
const TORCH_FRONT_FLAGS = 0x20e; // transparent, passable, never on map, no vertical tile
const TORCH_BACK_FLAGS = 0x20f; // the same, backwards

export function insertTorch(room: RoomSource, x: number, y: number, angle: number): { room: RoomSource; anchor: Pt } {
  const sector = sectorAtPoint(room, x + 0.25, y + 0.25);
  if (sector === null) throw new OpError("A torch has to go inside a sector.");
  const w = { vertices: room.vertices.slice(), linedefs: room.linedefs.slice() };

  // Snap the base onto a wall within 4 units, splitting it there (CheckAndMergeVertex).
  let px = Math.round(x);
  let py = Math.round(y);
  let base = w.vertices.findIndex(([vx, vy]) => vx === px && vy === py);
  if (base < 0) {
    w.vertices.push([px, py]);
    base = w.vertices.length - 1;
    for (let i = 0; i < w.linedefs.length; i++) {
      const l = w.linedefs[i]!;
      const near = nearestOnSegment([px, py], w.vertices[l.start]!, w.vertices[l.end]!);
      if (near.d <= 4 && near.t > 0 && near.t < 1) {
        px = Math.round(near.x);
        py = Math.round(near.y);
        w.vertices[base] = [px, py];
        splitLinedefAt(w, i, base);
        break;
      }
    }
  }

  const quarter = Math.trunc(angle / 90);
  let second: Pt, third: Pt, fourth: Pt, fifth: Pt;
  if (quarter === 1) {
    second = [px + 12, py];
    third = [px + 18, py];
    fourth = [px + 12, py + 8];
    fifth = [px + 12, py - 8];
  } else if (quarter === 2) {
    second = [px, py - 12];
    third = [px, py - 18];
    fourth = [px + 8, py - 12];
    fifth = [px - 8, py - 12];
  } else if (quarter === 3) {
    second = [px - 12, py];
    third = [px - 18, py];
    fourth = [px - 12, py - 8];
    fifth = [px - 12, py + 8];
  } else {
    second = [px, py + 12];
    third = [px, py + 18];
    fourth = [px - 8, py + 12];
    fifth = [px + 8, py + 12];
  }
  const add = (p: Pt): number => {
    w.vertices.push([p[0], p[1]]);
    return w.vertices.length - 1;
  };
  const v2 = add(second);
  const v3 = add(third);
  const v4 = add(fourth);
  const v5 = add(fifth);
  const side = (texture: number, xOffset: number, back: boolean): SourceSide => ({
    sector,
    normal: texture,
    above: 0,
    below: 0,
    xOffset,
    yOffset: 0,
    serverId: 0,
    animateSpeed: 90,
    flags: back ? TORCH_BACK_FLAGS : TORCH_FRONT_FLAGS,
  });
  w.linedefs.push(
    { start: v2, end: v3, front: side(8886, 12, false), back: side(8886, 12, true) },
    { start: base, end: v2, front: side(8886, 0, false), back: side(8886, 0, true) },
    { start: v2, end: v4, front: side(8887, 8, false), back: side(8886, 8, true) },
    { start: v5, end: v2, front: side(8887, 0, false), back: side(8887, 0, true) },
  );
  return { room: { ...room, ...w }, anchor: [px, py] };
}
