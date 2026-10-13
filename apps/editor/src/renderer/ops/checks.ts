// roomedit's Check menu: closed sectors, cross-references, missing textures,
// unknown textures and statistics. Each problem can point at an item and may
// carry a fix.

import type { RoomSource } from "@meridian-editor/roomc";
import { cross } from "./geom.ts";
import { deleteItems } from "./edit.ts";
import type { ItemRef } from "./types.ts";

export interface CheckIssue {
  severity: "error" | "warning";
  message: string;
  item?: ItemRef;
  /** A map point to centre on, for issues that aren't about one item. */
  at?: [number, number];
  fix?: { label: string; apply: (room: RoomSource) => RoomSource };
}

/** The first linedef hit by a ray from (ox, oy) along (dx, dy), ignoring `exclude`, and which of its sides faces the origin. */
export function castRay(room: RoomSource, ox: number, oy: number, dx: number, dy: number, exclude: number): { line: number; front: boolean; u: number } | null {
  let best = Infinity;
  let hit: { line: number; front: boolean; u: number } | null = null;
  room.linedefs.forEach((l, i) => {
    if (i === exclude) return;
    const a = room.vertices[l.start];
    const b = room.vertices[l.end];
    if (!a || !b) return;
    const sx = b[0] - a[0];
    const sy = b[1] - a[1];
    const denom = dx * sy - dy * sx;
    if (Math.abs(denom) < 1e-12) return;
    const t = ((a[0] - ox) * sy - (a[1] - oy) * sx) / denom;
    const u = ((a[0] - ox) * dy - (a[1] - oy) * dx) / denom;
    if (t <= 1e-9 || u < 0 || u > 1 || t >= best) return;
    best = t;
    // The origin is right of a→b: the front faces it.
    hit = { line: i, front: cross(a[0], a[1], b[0], b[1], ox, oy) < 0, u };
  });
  return hit;
}

/** roomedit CheckSectors: every sector's sides form closed loops, and facing sides agree. */
export function checkSectors(room: RoomSource): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const ends = new Map<number, Map<number, number>>();
  const mark = (sector: number, v: number, bit: number): void => {
    let m = ends.get(sector);
    if (!m) ends.set(sector, (m = new Map()));
    m.set(v, (m.get(v) ?? 0) | bit);
  };
  for (const l of room.linedefs) {
    if (l.front && l.front.sector >= 0) {
      mark(l.front.sector, l.start, 1);
      mark(l.front.sector, l.end, 2);
    }
    if (l.back && l.back.sector >= 0) {
      mark(l.back.sector, l.end, 1);
      mark(l.back.sector, l.start, 2);
    }
  }
  for (const [sector, m] of [...ends].sort((a, b) => a[0] - b[0])) {
    for (const [v, bits] of m) {
      if (bits === 1) issues.push({ severity: "error", message: `Sector ${sector} is not closed: no side ends at vertex ${v}`, item: { kind: "vertex", index: v } });
      if (bits === 2) issues.push({ severity: "error", message: `Sector ${sector} is not closed: no side starts at vertex ${v}`, item: { kind: "vertex", index: v } });
    }
  }

  room.linedefs.forEach((l, i) => {
    for (const front of [true, false]) {
      const side = front ? l.front : l.back;
      if (!side || side.sector < 0) continue;
      const a = room.vertices[l.start]!;
      const b = room.vertices[l.end]!;
      // Cast from a point beside the linedef, straight out from it. A ray
      // through a vertex can't tell which wall it hit, so try a few spots.
      const nx = front ? b[1] - a[1] : a[1] - b[1];
      const ny = front ? a[0] - b[0] : b[0] - a[0];
      let hit: ReturnType<typeof castRay> = null;
      for (const t of [0.5, 0.381966, 0.618034, 0.2763932]) {
        const len = Math.hypot(nx, ny) || 1;
        const px = a[0] + (b[0] - a[0]) * t + (nx / len) * 0.01;
        const py = a[1] + (b[1] - a[1]) * t + (ny / len) * 0.01;
        hit = castRay(room, px, py, nx, ny, i);
        if (!hit || (hit.u > 1e-6 && hit.u < 1 - 1e-6)) break;
      }
      const opposite = hit ? (hit.front ? room.linedefs[hit.line]!.front : room.linedefs[hit.line]!.back) : null;
      if (!hit || !opposite) {
        issues.push({ severity: "error", message: `Sector ${side.sector} is not closed: check linedef ${i} (${front ? "front" : "back"} side)`, item: { kind: "linedef", index: i } });
      } else if (opposite.sector !== side.sector) {
        issues.push({
          severity: "error",
          message: `Sectors ${side.sector} and ${opposite.sector} disagree: linedef ${i} (${front ? "front" : "back"}) faces linedef ${hit.line}`,
          item: { kind: "linedef", index: i },
        });
      }
    }
  });
  return issues;
}

/** roomedit CheckCrossReferences: broken linedefs, duplicates, and unused vertices and sectors (with fixes). */
export function checkCrossReferences(room: RoomSource): CheckIssue[] {
  const issues: CheckIssue[] = [];
  room.linedefs.forEach((l, i) => {
    if (!l.front) {
      issues.push({
        severity: l.back ? "warning" : "error",
        message: l.back ? `Linedef ${i} has only a back side` : `Linedef ${i} has no sides`,
        item: { kind: "linedef", index: i },
      });
    }
    if (l.start === l.end) issues.push({ severity: "error", message: `Linedef ${i} uses vertex ${l.start} twice`, item: { kind: "linedef", index: i } });
    for (const side of [l.front, l.back]) {
      if (side && side.sector >= room.sectors.length) issues.push({ severity: "error", message: `Linedef ${i} refers to missing sector ${side.sector}`, item: { kind: "linedef", index: i } });
    }
  });

  const seen = new Map<string, number>();
  const duplicates: number[] = [];
  room.linedefs.forEach((l, i) => {
    const key = l.start < l.end ? `${l.start},${l.end}` : `${l.end},${l.start}`;
    if (seen.has(key)) duplicates.push(i);
    else seen.set(key, i);
  });
  if (duplicates.length) {
    issues.push({
      severity: "warning",
      message: `${duplicates.length} linedef(s) duplicate another between the same vertices`,
      item: { kind: "linedef", index: duplicates[0]! },
      fix: { label: "Delete duplicates", apply: (r) => deleteItems(r, "linedef", duplicates) },
    });
  }

  const usedVertices = new Set<number>();
  for (const l of room.linedefs) {
    usedVertices.add(l.start);
    usedVertices.add(l.end);
  }
  const unusedVertices = room.vertices.map((_, i) => i).filter((i) => !usedVertices.has(i));
  if (unusedVertices.length) {
    issues.push({
      severity: "warning",
      message: `${unusedVertices.length} vertex(es) aren't used by any linedef`,
      item: { kind: "vertex", index: unusedVertices[0]! },
      fix: { label: "Delete unused vertices", apply: (r) => deleteItems(r, "vertex", unusedVertices) },
    });
  }

  const usedSectors = new Set<number>();
  for (const l of room.linedefs) for (const side of [l.front, l.back]) if (side && side.sector >= 0) usedSectors.add(side.sector);
  const unusedSectors = room.sectors.map((_, i) => i).filter((i) => !usedSectors.has(i));
  if (unusedSectors.length) {
    issues.push({
      severity: "warning",
      message: `${unusedSectors.length} sector(s) aren't used by any side`,
      item: { kind: "sector", index: unusedSectors[0]! },
      fix: { label: "Delete unused sectors", apply: (r) => deleteItems(r, "sector", unusedSectors) },
    });
  }
  return issues;
}

/** roomedit CheckTextures: wall faces that will show but have no texture. */
export function checkTextures(room: RoomSource): CheckIssue[] {
  const issues: CheckIssue[] = [];
  room.linedefs.forEach((l, i) => {
    const sec = (s: { sector: number } | null) => (s && s.sector >= 0 ? room.sectors[s.sector] : undefined);
    if (l.front && !l.back && l.front.normal === 0) issues.push({ severity: "warning", message: `Linedef ${i} front: one-sided wall without a normal texture`, item: { kind: "linedef", index: i } });
    if (l.back && !l.front && l.back.normal === 0) issues.push({ severity: "warning", message: `Linedef ${i} back: one-sided wall without a normal texture`, item: { kind: "linedef", index: i } });
    if (l.front && l.back) {
      const f = sec(l.front);
      const b = sec(l.back);
      if (!f || !b) return;
      if (f.floorHeight < b.floorHeight && l.front.below === 0) issues.push({ severity: "warning", message: `Linedef ${i} front: step up without a below texture`, item: { kind: "linedef", index: i } });
      if (b.floorHeight < f.floorHeight && l.back.below === 0) issues.push({ severity: "warning", message: `Linedef ${i} back: step up without a below texture`, item: { kind: "linedef", index: i } });
      if (f.ceilingHeight > b.ceilingHeight && l.front.above === 0) issues.push({ severity: "warning", message: `Linedef ${i} front: ceiling drop without an above texture`, item: { kind: "linedef", index: i } });
      if (b.ceilingHeight > f.ceilingHeight && l.back.above === 0) issues.push({ severity: "warning", message: `Linedef ${i} back: ceiling drop without an above texture`, item: { kind: "linedef", index: i } });
    }
  });
  room.sectors.forEach((s, i) => {
    if (s.floorTexture === 0) issues.push({ severity: "warning", message: `Sector ${i} has no floor texture (the original server marks its squares unwalkable)`, item: { kind: "sector", index: i } });
  });
  return issues;
}

/** roomedit CheckTextureNames: texture numbers with no grdNNNNN.bgf in the texture library. */
export function checkTextureNames(room: RoomSource, known: ReadonlySet<number>): CheckIssue[] {
  if (known.size === 0) return [{ severity: "warning", message: "No texture library loaded; set the textures folder first" }];
  const issues: CheckIssue[] = [];
  const report = (tex: number, what: string, item: ItemRef): void => {
    if (tex !== 0 && !known.has(tex)) issues.push({ severity: "warning", message: `${what} uses texture ${tex}, which isn't in the texture library`, item });
  };
  room.linedefs.forEach((l, i) => {
    for (const [side, name] of [
      [l.front, "front"],
      [l.back, "back"],
    ] as const) {
      if (!side) continue;
      report(side.normal, `Linedef ${i} ${name} normal`, { kind: "linedef", index: i });
      report(side.above, `Linedef ${i} ${name} above`, { kind: "linedef", index: i });
      report(side.below, `Linedef ${i} ${name} below`, { kind: "linedef", index: i });
    }
  });
  room.sectors.forEach((s, i) => {
    report(s.floorTexture, `Sector ${i} floor`, { kind: "sector", index: i });
    report(s.ceilingTexture, `Sector ${i} ceiling`, { kind: "sector", index: i });
  });
  return issues;
}

export function statistics(room: RoomSource): { label: string; value: number }[] {
  const sides = room.linedefs.reduce((n, l) => n + (l.front ? 1 : 0) + (l.back ? 1 : 0), 0);
  const twoSided = room.linedefs.filter((l) => l.front && l.back).length;
  const textures = new Set<number>();
  for (const l of room.linedefs) for (const s of [l.front, l.back]) if (s) [s.normal, s.above, s.below].forEach((t) => t && textures.add(t));
  for (const s of room.sectors) [s.floorTexture, s.ceilingTexture].forEach((t) => t && textures.add(t));
  return [
    { label: "Things", value: room.things.length },
    { label: "Vertices", value: room.vertices.length },
    { label: "Linedefs", value: room.linedefs.length },
    { label: "Two-sided linedefs", value: twoSided },
    { label: "Sides", value: sides },
    { label: "Sectors", value: room.sectors.length },
    { label: "Sloped sectors", value: room.sectors.filter((s) => s.flags & 0xc00).length },
    { label: "Textures used", value: textures.size },
  ];
}
