// Reading the room: summaries, raw items, searches, a sector's shape and
// neighbours, what's at a point, and coordinate conversions.

import { z } from "zod";
import type { RoomSource, SourceSide } from "@meridian-editor/roomc";
import { WF } from "@meridian-editor/roo";
import { statistics } from "../../../../apps/editor/src/renderer/ops/checks.ts";
import { adjacency, heKey, sectorAtPoint, traceFace, type HalfEdge } from "../../../../apps/editor/src/renderer/ops/geom.ts";
import { hitTest, kodCoords, roomBounds, roomBoxSize, sectorPieces } from "../../../../apps/editor/src/renderer/geometry.ts";
import { kodMarks, kodToEditor, roomBox } from "../../../../apps/editor/src/renderer/kod/kodRooms.ts";
import { OpError } from "../session.ts";
import { describeFlags } from "../flags.ts";
import { coord, index, kind, needIndices, tool } from "../tool.ts";

// ---------------------------------------------------------------- item views

function sideView(s: SourceSide | null): Record<string, unknown> | null {
  if (!s) return null;
  return { ...s, flags: describeFlags("wall", s.flags) };
}

export function itemView(room: RoomSource, k: z.infer<typeof kind>, i: number): Record<string, unknown> {
  switch (k) {
    case "vertex": {
      const [x, y] = room.vertices[i]!;
      return { index: i, x, y };
    }
    case "linedef": {
      const l = room.linedefs[i]!;
      const a = room.vertices[l.start]!;
      const b = room.vertices[l.end]!;
      return { index: i, start: l.start, end: l.end, from: a, to: b, length: Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) * 100) / 100, front: sideView(l.front), back: sideView(l.back) };
    }
    case "sector": {
      const s = room.sectors[i]!;
      return { index: i, ...s, flags: describeFlags("sector", s.flags) };
    }
    case "thing": {
      const t = room.things[i]!;
      return { index: i, ...t, ...(i < 2 ? { role: "room-box corner" } : {}) };
    }
  }
}

// ---------------------------------------------------------------- sector shape

/** The loops around a sector: each traced with the sector on the right of every wall. */
export function sectorLoops(room: RoomSource, sector: number): { vertices: number[]; points: [number, number][]; linedefs: number[]; area: number; hole: boolean }[] {
  const adj = adjacency(room);
  const seen = new Set<string>();
  const loops: { vertices: number[]; points: [number, number][]; linedefs: number[]; area: number; hole: boolean }[] = [];
  room.linedefs.forEach((l, i) => {
    for (const front of [true, false]) {
      const side = front ? l.front : l.back;
      const h: HalfEdge = { line: i, front };
      if (!side || side.sector !== sector || seen.has(heKey(h))) continue;
      const face = traceFace(room, adj, h);
      if (!face) continue;
      for (const e of face.edges) seen.add(heKey(e));
      const vertices = face.edges.map((e) => {
        const ld = room.linedefs[e.line]!;
        return e.front ? ld.start : ld.end;
      });
      const points = vertices.map((v) => room.vertices[v]!);
      // Walked clockwise (negative) it's the sector's outline; counter-clockwise, a hole in it.
      loops.push({ vertices, points, linedefs: face.edges.map((e) => e.line), area: Math.abs(face.area), hole: face.area > 0 });
    }
  });
  return loops;
}

function describeSector(room: RoomSource, i: number): Record<string, unknown> {
  const s = room.sectors[i]!;
  const loops = sectorLoops(room, i);
  const outer = loops.filter((l) => !l.hole);
  const area = outer.reduce((n, l) => n + l.area, 0) - loops.filter((l) => l.hole).reduce((n, l) => n + l.area, 0);
  const pts = outer.flatMap((l) => l.points);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const neighbours = new Map<number, { linedefs: number[]; passable: boolean }>();
  const walls: number[] = [];
  room.linedefs.forEach((l, li) => {
    for (const [mine, other] of [
      [l.front, l.back],
      [l.back, l.front],
    ] as const) {
      if (mine?.sector !== i) continue;
      if (!other || other.sector < 0) {
        walls.push(li);
        continue;
      }
      if (other.sector === i) continue;
      const n = neighbours.get(other.sector) ?? { linedefs: [], passable: false };
      n.linedefs.push(li);
      // Walking out of this sector goes through this sector's side of the wall.
      if (mine.flags & WF.PASSABLE) n.passable = true;
      neighbours.set(other.sector, n);
    }
  });
  return {
    ...itemView(room, "sector", i),
    area: Math.round(area),
    bounds: pts.length ? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } : null,
    loops: loops.map((l) => ({ hole: l.hole, area: Math.round(l.area), points: l.points, vertices: l.vertices, linedefs: l.linedefs })),
    solidWalls: walls,
    neighbours: [...neighbours].map(([n, v]) => {
      const o = room.sectors[n]!;
      return {
        sector: n,
        floorStep: o.floorHeight - s.floorHeight,
        ceiling: o.ceilingHeight,
        headroom: Math.min(o.ceilingHeight, s.ceilingHeight) - Math.max(o.floorHeight, s.floorHeight),
        passableFromHere: v.passable,
        linedefs: v.linedefs,
      };
    }),
    note: "Walking: a step up of more than 24 or less than 48 headroom blocks the player; so does a wall side without the passable flag.",
  };
}

// ---------------------------------------------------------------- searching

const where = z
  .object({
    texture: z.number().int().optional().describe("Linedefs: any wall texture (normal, above or below) on either side. Sectors: floor or ceiling texture"),
    normal: z.number().int().optional(),
    above: z.number().int().optional(),
    below: z.number().int().optional(),
    floorTexture: z.number().int().optional(),
    ceilingTexture: z.number().int().optional(),
    serverId: z.number().int().optional().describe("Sector server id, or a wall side's server id"),
    light: z.number().int().optional(),
    floorHeight: z.number().int().optional(),
    ceilingHeight: z.number().int().optional(),
    sector: z.number().int().optional().describe("Linedefs with a side in this sector"),
    oneSided: z.boolean().optional().describe("Linedefs: only one-sided (solid walls) or only two-sided"),
    flag: z.string().optional().describe("Has this named flag (wall flags for linedefs, sector flags for sectors)"),
    sloped: z.boolean().optional(),
    bbox: z.tuple([coord, coord, coord, coord]).optional().describe("[minX, minY, maxX, maxY]: items with a point inside"),
  })
  .describe("All given conditions must hold");

function matches(room: RoomSource, k: z.infer<typeof kind>, i: number, w: z.infer<typeof where>): boolean {
  const inBox = (x: number, y: number): boolean => !w.bbox || (x >= w.bbox[0] && y >= w.bbox[1] && x <= w.bbox[2] && y <= w.bbox[3]);
  if (k === "vertex") {
    const [x, y] = room.vertices[i]!;
    return inBox(x, y);
  }
  if (k === "thing") {
    const t = room.things[i]!;
    return inBox(t.x, t.y);
  }
  if (k === "sector") {
    const s = room.sectors[i]!;
    if (w.texture !== undefined && s.floorTexture !== w.texture && s.ceilingTexture !== w.texture) return false;
    for (const key of ["floorTexture", "ceilingTexture", "serverId", "light", "floorHeight", "ceilingHeight"] as const) if (w[key] !== undefined && s[key] !== w[key]) return false;
    if (w.flag && !(describeFlags("sector", s.flags).on as string[]).includes(w.flag)) return false;
    if (w.sloped !== undefined && !!(s.floorSlope || s.ceilingSlope) !== w.sloped) return false;
    if (w.bbox) {
      const pts = sectorLoops(room, i).flatMap((l) => l.points);
      if (!pts.some(([x, y]) => inBox(x, y))) return false;
    }
    return true;
  }
  const l = room.linedefs[i]!;
  const sides = [l.front, l.back].filter((s): s is SourceSide => !!s);
  if (w.texture !== undefined && !sides.some((s) => s.normal === w.texture || s.above === w.texture || s.below === w.texture)) return false;
  for (const key of ["normal", "above", "below", "serverId"] as const) if (w[key] !== undefined && !sides.some((s) => s[key] === w[key])) return false;
  if (w.sector !== undefined && !sides.some((s) => s.sector === w.sector)) return false;
  if (w.oneSided !== undefined && (sides.length === 1) !== w.oneSided) return false;
  if (w.flag && !sides.some((s) => (describeFlags("wall", s.flags).on as string[]).includes(w.flag!))) return false;
  if (w.bbox) {
    const a = room.vertices[l.start]!;
    const b = room.vertices[l.end]!;
    if (!inBox(a[0], a[1]) && !inBox(b[0], b[1])) return false;
  }
  return true;
}

// ---------------------------------------------------------------- tools

export function kodPoint(room: RoomSource, x: number, y: number): Record<string, number> | null {
  return kodCoords(room, x, y);
}

export const readTools = [
  tool({
    name: "room_summary",
    title: "Room summary",
    description: "Counts, the room box (its size in squares), the drawn area, server ids in use, textures used, heights, and compat quirks.",
    input: {},
    annotations: { readOnlyHint: true },
    run: (s) => {
      const room = s.room();
      const box = roomBoxSize(room);
      const b = roomBounds(room);
      const textures = new Set<number>();
      for (const l of room.linedefs) for (const sd of [l.front, l.back]) if (sd) [sd.normal, sd.above, sd.below].forEach((t) => t && textures.add(t));
      for (const sc of room.sectors) [sc.floorTexture, sc.ceilingTexture].forEach((t) => t && textures.add(t));
      const floors = room.sectors.map((x) => x.floorHeight);
      const ceilings = room.sectors.map((x) => x.ceilingHeight);
      return {
        room: s.doc()?.name,
        roomId: room.roomId,
        revision: s.revision(),
        statistics: Object.fromEntries(statistics(room).map((r) => [r.label, r.value])),
        roomBox: box && { ...box, corners: room.things.slice(0, 2).map((t) => [t.x, t.y]) },
        drawn: { ...b, widthSquares: (b.maxX - b.minX) / 64, heightSquares: (b.maxY - b.minY) / 64 },
        heights: floors.length ? { floor: [Math.min(...floors), Math.max(...floors)], ceiling: [Math.min(...ceilings), Math.max(...ceilings)] } : null,
        sectorServerIds: room.sectors.flatMap((x, i) => (x.serverId ? [{ sector: i, serverId: x.serverId }] : [])),
        wallServerIds: room.linedefs.flatMap((l, i) => [l.front, l.back].flatMap((sd) => (sd?.serverId ? [{ linedef: i, serverId: sd.serverId }] : []))),
        texturesUsed: [...textures].sort((a, c) => a - c),
        compat: room.compat ?? null,
        extraThings: Math.max(0, room.things.length - 2),
      };
    },
  }),

  tool({
    name: "get_items",
    title: "Get items",
    description: "Room source records by index, with flags spelled out. Give indices, or a start and count to page through (at most 200 at a time).",
    input: {
      kind,
      indices: z.array(index).optional(),
      start: index.optional(),
      count: z.number().int().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: true },
    run: (s, { kind: k, indices, start, count }) => {
      const room = s.room();
      const total = { vertex: room.vertices.length, linedef: room.linedefs.length, sector: room.sectors.length, thing: room.things.length }[k];
      let list = indices;
      if (list) needIndices(room, k, list);
      else {
        const from = start ?? 0;
        list = Array.from({ length: Math.max(0, Math.min(count ?? 50, total - from)) }, (_, i) => from + i);
      }
      return { kind: k, total, revision: s.revision(), items: list.slice(0, 200).map((i) => itemView(room, k, i)) };
    },
  }),

  tool({
    name: "find_items",
    title: "Find items",
    description: "Find linedefs, sectors, vertices or things by texture, height, light, server id, sector, flag or area (the Find dialog). Pair with set_properties to change what it finds.",
    input: { kind, where, limit: z.number().int().min(1).max(5000).optional() },
    annotations: { readOnlyHint: true },
    run: (s, { kind: k, where: w, limit }) => {
      const room = s.room();
      const n = { vertex: room.vertices.length, linedef: room.linedefs.length, sector: room.sectors.length, thing: room.things.length }[k];
      const found: number[] = [];
      for (let i = 0; i < n; i++) if (matches(room, k, i, w)) found.push(i);
      return { kind: k, count: found.length, indices: found.slice(0, limit ?? 1000), revision: s.revision() };
    },
  }),

  tool({
    name: "describe_sector",
    title: "Describe a sector",
    description: "A sector's fields, its outline and holes as ordered points (sector on the right of each wall), area, bounds, solid walls, and each neighbouring sector with the step, headroom and whether you can walk across.",
    input: { index },
    annotations: { readOnlyHint: true },
    run: (s, { index: i }) => {
      const room = s.room();
      needIndices(room, "sector", [i]);
      return { revision: s.revision(), ...describeSector(room, i) };
    },
  }),

  tool({
    name: "describe_linedef",
    title: "Describe a linedef",
    description: "A linedef's ends, length, direction, both sides with their sectors' heights, and whether the player can cross it each way.",
    input: { index },
    annotations: { readOnlyHint: true },
    run: (s, { index: i }) => {
      const room = s.room();
      needIndices(room, "linedef", [i]);
      const l = room.linedefs[i]!;
      const a = room.vertices[l.start]!;
      const b = room.vertices[l.end]!;
      const sec = (sd: SourceSide | null) => (sd && sd.sector >= 0 ? room.sectors[sd.sector] : undefined);
      const f = sec(l.front);
      const k = sec(l.back);
      const cross = (from: typeof f, to: typeof f, side: SourceSide | null): string => {
        if (!from || !to || !side) return "no: solid wall";
        if (!(side.flags & WF.PASSABLE)) return "no: this side isn't passable";
        if (to.floorHeight - from.floorHeight > 24) return `no: a step up of ${to.floorHeight - from.floorHeight}`;
        if (Math.min(from.ceilingHeight, to.ceilingHeight) - to.floorHeight < 48) return "no: too low";
        return "yes";
      };
      return {
        revision: s.revision(),
        ...itemView(room, "linedef", i),
        direction: Math.round((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI),
        frontSector: l.front?.sector ?? null,
        backSector: l.back?.sector ?? null,
        note: "The front side is on the right going from start to end (y up).",
        crossing: { frontToBack: cross(f, k, l.front), backToFront: cross(k, f, l.back) },
      };
    },
  }),

  tool({
    name: "at_point",
    title: "What's at a point",
    description: "The sector at an editor point (with its floor and ceiling), the nearest vertex, linedef and thing within a tolerance, the Kod square there, and the Kod placements on that square.",
    input: { x: coord, y: coord, tolerance: z.number().positive().optional().describe("Editor units; default 8") },
    annotations: { readOnlyHint: true },
    run: async (s, { x, y, tolerance }) => {
      const room = s.room();
      const c = s.compile();
      const pieces = c.ok ? sectorPieces(c.file, c.origin) : null;
      const sector = sectorAtPoint(room, x, y);
      const hit = hitTest(room, pieces, x, y, tolerance ?? 8, true);
      const kod = kodCoords(room, x, y);
      const k = await s.kodRoom();
      const box = roomBox(room.things);
      const marks = k.room && box && kod ? kodMarks(k.room, box).filter((m) => m.row === kod.row && m.col === kod.col) : [];
      return {
        sector: sector === null ? null : { index: sector, floorHeight: room.sectors[sector]!.floorHeight, ceilingHeight: room.sectors[sector]!.ceilingHeight },
        nearest: hit,
        kod,
        kodPlacements: marks.map((m) => ({ kind: m.kind, label: m.label })),
      };
    },
  }),

  tool({
    name: "convert_coords",
    title: "Convert coordinates",
    description:
      "Between editor units (64 a square, y up, used by every edit tool), Kod squares (row and col from 1 at the room box's top-left, fine 0–63 within: what Kod's #new_row/#new_col/#fine_row/#fine_col take) and client units (16 per editor unit, y down from the top-left).",
    input: {
      from: z.enum(["editor", "kod", "client"]),
      x: z.number().optional(),
      y: z.number().optional(),
      row: z.number().int().optional(),
      col: z.number().int().optional(),
      fineRow: z.number().int().min(0).max(63).optional(),
      fineCol: z.number().int().min(0).max(63).optional(),
    },
    annotations: { readOnlyHint: true },
    run: (s, a) => {
      const room = s.room();
      const box = roomBox(room.things);
      if (!box) throw new OpError("The room has no room box (things 0 and 1).");
      let ex: number;
      let ey: number;
      if (a.from === "editor") {
        if (a.x === undefined || a.y === undefined) throw new OpError("Give x and y.");
        [ex, ey] = [a.x, a.y];
      } else if (a.from === "kod") {
        if (a.row === undefined || a.col === undefined) throw new OpError("Give row and col.");
        [ex, ey] = kodToEditor(box, { row: a.row, col: a.col, fineRow: a.fineRow ?? 32, fineCol: a.fineCol ?? 32 });
      } else {
        if (a.x === undefined || a.y === undefined) throw new OpError("Give x and y.");
        [ex, ey] = [box.left + a.x / 16, box.top - a.y / 16];
      }
      const k = kodPoint(room, ex, ey)!;
      return {
        editor: [ex, ey],
        kod: { ...k, kod: `#new_row=${k.row},#new_col=${k.col},#fine_row=${k.fineRow},#fine_col=${k.fineCol}` },
        client: [(ex - box.left) * 16, (box.top - ey) * 16],
        squareCentre: kodToEditor(box, { row: k.row, col: k.col, fineRow: 32, fineCol: 32 }),
      };
    },
  }),
];
