// roomedit's object operations (objects.cpp) on room sources: delete with
// cascades, merge and join, flip and swap, split, door and lift, distribute,
// align textures, rotate and scale, copy. All return a new room.

import type { RoomSource, SourceLinedef, SourceSector, SourceSide, SourceSlope, SourceThing } from "@meridian-editor/roomc";
import { insertPath, splitLinedefAt, type DrawDefaults } from "./draw.ts";
import { OpError, type ItemKind } from "./types.ts";

const SLOPED = 0xc00;

// ---------------------------------------------------------------- deleting

/** Delete items of one kind, with roomedit's cascades. Returns the new room. */
export function deleteItems(room: RoomSource, kind: ItemKind, indices: readonly number[]): RoomSource {
  const gone = new Set(indices);
  if (gone.size === 0) return room;
  switch (kind) {
    case "thing":
      return { ...room, things: room.things.filter((_, i) => !gone.has(i)) };
    case "vertex": {
      // Linedefs on a deleted vertex go too; slopes resting on one are turned off.
      const doomed = new Set(room.vertices.filter((_, i) => gone.has(i)).map(([x, y]) => `${x},${y}`));
      const linedefs = room.linedefs.filter((l) => !gone.has(l.start) && !gone.has(l.end));
      const sectors = room.sectors.map((s) => dropSlopesOn(s, doomed));
      return reindexVertices({ ...room, linedefs, sectors }, (i) => !gone.has(i));
    }
    case "linedef":
      return pruneVertices({ ...room, linedefs: room.linedefs.filter((_, i) => !gone.has(i)) });
    case "sector": {
      // Sides facing a deleted sector go; linedefs left with no sides go too.
      const map = remap(room.sectors.length, gone);
      const fix = (s: SourceSide | null): SourceSide | null => (s ? (gone.has(s.sector) ? null : s.sector >= 0 ? { ...s, sector: map[s.sector]! } : s) : null);
      const linedefs = room.linedefs
        .map((l) => {
          const front = fix(l.front);
          const back = fix(l.back);
          if (!front && back) return { start: l.end, end: l.start, front: back, back: null };
          return { ...l, front, back };
        })
        .filter((l) => l.front || l.back);
      return pruneVertices({ ...room, linedefs, sectors: room.sectors.filter((_, i) => !gone.has(i)) });
    }
  }
}

function remap(count: number, gone: ReadonlySet<number>): number[] {
  const map: number[] = [];
  let next = 0;
  for (let i = 0; i < count; i++) map[i] = gone.has(i) ? -1 : next++;
  return map;
}

function dropSlopesOn(s: SourceSector, doomed: ReadonlySet<string>): SourceSector {
  const hits = (slope: SourceSlope | null): boolean => !!slope && slope.points.some(([x, y]) => doomed.has(`${x},${y}`));
  const floor = hits(s.floorSlope);
  const ceiling = hits(s.ceilingSlope);
  if (!floor && !ceiling) return s;
  return {
    ...s,
    flags: s.flags & ~(floor ? 0x400 : 0) & ~(ceiling ? 0x800 : 0),
    floorSlope: floor ? null : s.floorSlope,
    ceilingSlope: ceiling ? null : s.ceilingSlope,
  };
}

function reindexVertices(room: RoomSource, keep: (i: number) => boolean): RoomSource {
  const map: number[] = [];
  const vertices: [number, number][] = [];
  room.vertices.forEach((v, i) => {
    if (!keep(i)) return;
    map[i] = vertices.length;
    vertices.push(v);
  });
  return { ...room, vertices, linedefs: room.linedefs.map((l) => ({ ...l, start: map[l.start]!, end: map[l.end]! })) };
}

/** Drop vertices no linedef or slope uses. */
export function pruneVertices(room: RoomSource): RoomSource {
  const used = new Set<number>();
  for (const l of room.linedefs) {
    used.add(l.start);
    used.add(l.end);
  }
  const slopePoints = new Set<string>();
  for (const s of room.sectors) for (const slope of [s.floorSlope, s.ceilingSlope]) slope?.points.forEach(([x, y]) => slopePoints.add(`${x},${y}`));
  const keep = (i: number): boolean => used.has(i) || slopePoints.has(`${room.vertices[i]![0]},${room.vertices[i]![1]}`);
  if (room.vertices.every((_, i) => keep(i))) return room;
  return reindexVertices(room, keep);
}

// ---------------------------------------------------------------- vertices

/** roomedit MergeVertices: everything on the other vertices moves to the first one. */
export function mergeVertices(room: RoomSource, indices: readonly number[]): RoomSource {
  if (indices.length < 2) throw new OpError("Select at least two vertices to merge.");
  const [keep, ...rest] = indices as [number, ...number[]];
  const others = new Set(rest);
  const to = (v: number): number => (others.has(v) ? keep : v);
  const linedefs = room.linedefs.map((l) => ({ ...l, start: to(l.start), end: to(l.end) })).filter((l) => l.start !== l.end);
  return reindexVertices({ ...room, linedefs }, (i) => !others.has(i));
}

/** roomedit DeleteVerticesJoinLineDefs: a vertex that ends one linedef and starts another disappears, joining them. */
export function deleteVertexJoinLinedefs(room: RoomSource, vertex: number): RoomSource {
  const starts = room.linedefs.flatMap((l, i) => (l.start === vertex ? [i] : []));
  const ends = room.linedefs.flatMap((l, i) => (l.end === vertex ? [i] : []));
  if (starts.length !== 1 || ends.length !== 1) {
    throw new OpError(`Vertex ${vertex} must be the start of one linedef and the end of another to join them.`);
  }
  const linedefs = room.linedefs.slice();
  linedefs[ends[0]!] = { ...linedefs[ends[0]!]!, end: linedefs[starts[0]!]!.end };
  linedefs.splice(starts[0]!, 1);
  return reindexVertices({ ...room, linedefs }, (i) => i !== vertex);
}

// ---------------------------------------------------------------- linedefs

/** roomedit FlipLineDefs: swap ends (and sides, so each side keeps its sector) — or just swap the sides. */
export function flipLinedefs(room: RoomSource, indices: readonly number[], swapVertices: boolean): RoomSource {
  const linedefs = room.linedefs.slice();
  for (const i of indices) {
    const l = linedefs[i]!;
    linedefs[i] = swapVertices ? { start: l.end, end: l.start, front: l.back, back: l.front } : { ...l, front: l.back, back: l.front };
  }
  return { ...room, linedefs };
}

/** roomedit SplitLineDefs: a new vertex at each midpoint. */
export function splitLinedefs(room: RoomSource, indices: readonly number[]): { room: RoomSource; vertices: number[] } {
  const w = { vertices: room.vertices.slice(), linedefs: room.linedefs.slice() };
  const vertices: number[] = [];
  for (const i of indices) {
    const l = w.linedefs[i]!;
    const a = w.vertices[l.start]!;
    const b = w.vertices[l.end]!;
    w.vertices.push([Math.trunc((a[0] + b[0]) / 2), Math.trunc((a[1] + b[1]) / 2)]);
    const v = w.vertices.length - 1;
    splitLinedefAt(w, i, v);
    vertices.push(v);
  }
  return { room: { ...room, ...w }, vertices };
}

/** roomedit DeleteLineDefsJoinSectors: remove two-sided linedefs and merge the sectors on either side. */
export function deleteLinedefsJoinSectors(room: RoomSource, indices: readonly number[]): RoomSource {
  for (const i of indices) {
    const l = room.linedefs[i]!;
    if (!l.front || !l.back) throw new OpError(`Linedef ${i} has only one side.`);
    if (l.front.sector < 0 || l.back.sector < 0) throw new OpError(`Linedef ${i} has a side with no sector.`);
  }
  let out = room;
  // Merge pair by pair, following renumbering as sectors disappear.
  const pairs = indices.map((i) => [room.linedefs[i]!.front!.sector, room.linedefs[i]!.back!.sector] as [number, number]);
  const alias = new Map<number, number>();
  const find = (s: number): number => {
    while (alias.has(s)) s = alias.get(s)!;
    return s;
  };
  for (const [a, b] of pairs) {
    const ka = find(a);
    const kb = find(b);
    if (ka !== kb) alias.set(Math.max(ka, kb), Math.min(ka, kb));
  }
  const groups = new Map<number, number[]>();
  for (const s of alias.keys()) {
    const root = find(s);
    groups.set(root, [...(groups.get(root) ?? [root]), s]);
  }
  out = { ...out, linedefs: out.linedefs.filter((_, i) => !indices.includes(i)) };
  for (const group of [...groups.values()]) {
    out = mergeSectorsRaw(out, group);
  }
  return pruneVertices(out);
}

/** roomedit AlignTexturesY: line up y offsets against the first side's reference height. */
export function alignTexturesY(room: RoomSource, indices: readonly number[]): RoomSource {
  const sides: { line: number; front: boolean }[] = [];
  for (const i of indices) {
    const l = room.linedefs[i]!;
    if (l.front) sides.push({ line: i, front: true });
    if (l.back) sides.push({ line: i, front: false });
  }
  if (sides.length === 0) return room;
  const refHeight = (h: { line: number; front: boolean }): number => {
    const l = room.linedefs[h.line]!;
    const side = h.front ? l.front! : l.back!;
    const other = h.front ? l.back : l.front;
    if (!other) return 0;
    let sector = side.sector;
    const os = other.sector;
    if (os > 0 && sector >= 0) {
      const a = room.sectors[os]!;
      const b = room.sectors[sector]!;
      if (a.ceilingHeight < b.ceilingHeight && a.ceilingHeight > b.floorHeight) sector = os;
    }
    return sector >= 0 ? room.sectors[sector]!.ceilingHeight : 0;
  };
  const ref = refHeight(sides[0]!);
  let out = room;
  sides.forEach((h, n) => {
    const yOffset = n === 0 ? 0 : (ref - refHeight(h)) % 128;
    out = patchSideAt(out, h.line, h.front, { yOffset });
  });
  return out;
}

export type WallPart = "normal" | "above" | "below";

/**
 * roomedit AlignTexturesX: x offsets run on along a chain of linedefs (each
 * starting where the last ended), wrapping at the texture's width.
 */
export function alignTexturesX(
  room: RoomSource,
  indices: readonly number[],
  options: { front: boolean; part: WallPart; initialOffset: number; textureWidth: (texture: number) => number | null },
): RoomSource {
  const chain = indices.filter((i) => (options.front ? room.linedefs[i]!.front : room.linedefs[i]!.back));
  if (chain.length === 0) throw new OpError(`None of the selected linedefs has a ${options.front ? "front" : "back"} side.`);
  const first = room.linedefs[chain[0]!]!;
  const tex = (options.front ? first.front! : first.back!)[options.part];
  if (tex === 0) throw new OpError(`Linedef ${chain[0]} has no ${options.part} texture on that side.`);
  const width = options.textureWidth(tex);
  if (!width) throw new OpError(`Texture ${tex} isn't in the texture library, so its width is unknown.`);

  let out = room;
  let offset = options.initialOffset;
  let prevEnd = -1;
  for (const i of chain) {
    const l = room.linedefs[i]!;
    // Each side walks its linedef from its own start: the back side runs end → start.
    const [s, e] = options.front ? [l.start, l.end] : [l.end, l.start];
    if (prevEnd !== -1 && s !== prevEnd) throw new OpError(`Linedef ${i} doesn't continue from the previous one; select a connected chain in order.`);
    out = patchSideAt(out, i, options.front, { xOffset: offset });
    const a = room.vertices[s]!;
    const b = room.vertices[e]!;
    offset = (offset + Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]))) % width;
    prevEnd = e;
  }
  return out;
}

/** The closed chain of linedefs through `start` (roomedit's "circle" alignment), in walking order. */
export function loopFrom(room: RoomSource, start: number): number[] {
  const out = [start];
  let end = room.linedefs[start]!.end;
  for (let n = 0; n < 1024; n++) {
    if (end === room.linedefs[start]!.start) return out;
    const next = room.linedefs.findIndex((l, i) => !out.includes(i) && l.start === end);
    if (next < 0) throw new OpError("The selected linedef isn't part of a closed loop.");
    out.push(next);
    end = room.linedefs[next]!.end;
  }
  throw new OpError("Too many linedefs in the loop.");
}

function patchSideAt(room: RoomSource, line: number, front: boolean, patch: Partial<SourceSide>): RoomSource {
  const l = room.linedefs[line]!;
  const side = front ? l.front : l.back;
  if (!side) return room;
  const linedefs = room.linedefs.slice();
  linedefs[line] = front ? { ...l, front: { ...side, ...patch } } : { ...l, back: { ...side, ...patch } };
  return { ...room, linedefs };
}

// ---------------------------------------------------------------- sectors

/** roomedit MergeSectors: every side of the others joins the first sector; the others are deleted. */
export function mergeSectors(room: RoomSource, indices: readonly number[]): RoomSource {
  if (indices.length < 2) throw new OpError("Select at least two sectors to merge.");
  return mergeSectorsRaw(room, indices);
}

function mergeSectorsRaw(room: RoomSource, indices: readonly number[]): RoomSource {
  const [keep, ...rest] = indices as [number, ...number[]];
  const others = new Set(rest);
  const to = (s: SourceSide | null): SourceSide | null => (s && others.has(s.sector) ? { ...s, sector: keep } : s);
  const merged: RoomSource = { ...room, linedefs: room.linedefs.map((l) => ({ ...l, front: to(l.front), back: to(l.back) })) };
  return deleteItems(merged, "sector", rest);
}

/** Smallest positive sector server id not in use (roomedit FindFreeTag). */
export function freeSectorServerId(room: RoomSource): number {
  const used = new Set(room.sectors.map((s) => s.serverId));
  let id = 1;
  while (used.has(id)) id++;
  return id;
}

/** Smallest positive wall server id not in use. */
export function freeWallServerId(room: RoomSource): number {
  const used = new Set<number>();
  for (const l of room.linedefs) for (const s of [l.front, l.back]) if (s) used.add(s.serverId);
  let id = 1;
  while (used.has(id)) id++;
  return id;
}

/** Linedefs between `sector` and another sector, flipped so `sector` is on the back (roomedit's door/lift layout). */
function bordersFacingIn(room: RoomSource, sector: number): { room: RoomSource; borders: number[]; walls: number[]; neighbours: Set<number> } {
  const borders: number[] = [];
  const walls: number[] = [];
  const neighbours = new Set<number>();
  const toFlip: number[] = [];
  room.linedefs.forEach((l, i) => {
    if (l.front && l.back) {
      if (l.back.sector === sector && l.front.sector !== sector) {
        borders.push(i);
        neighbours.add(l.front.sector);
      } else if (l.front.sector === sector && l.back.sector !== sector) {
        borders.push(i);
        toFlip.push(i);
        neighbours.add(l.back.sector);
      }
    } else if (l.front?.sector === sector) walls.push(i);
  });
  return { room: flipLinedefs(room, toFlip, true), borders, walls, neighbours };
}

/**
 * roomedit MakeDoorFromSector, for Meridian: the door sector sits behind its
 * borders, closes (ceiling down to floor) and gets a free server id so Kod
 * can open it with SetSector. Faces of the doorway take the wall texture.
 */
export function makeDoor(room: RoomSource, sector: number): RoomSource {
  const b = bordersFacingIn(room, sector);
  if (b.neighbours.size < 2) throw new OpError("A door must connect two other sectors.");
  let out = b.room;
  for (const i of b.borders) {
    const l = out.linedefs[i]!;
    const outside = l.front!;
    const above = outside.above || outside.normal;
    const linedefs = out.linedefs.slice();
    linedefs[i] = { ...l, front: { ...outside, above, normal: 0 }, back: { ...l.back!, normal: 0 } };
    out = { ...out, linedefs };
  }
  const s = out.sectors[sector]!;
  const sectors = out.sectors.slice();
  sectors[sector] = { ...s, ceilingHeight: s.floorHeight, serverId: s.serverId || freeSectorServerId(out) };
  return { ...out, sectors };
}

/**
 * roomedit MakeLiftFromSector, for Meridian: the lift rises to its highest
 * neighbour, keeps 56 units of headroom, and gets a free server id.
 */
export function makeLift(room: RoomSource, sector: number): RoomSource {
  const b = bordersFacingIn(room, sector);
  if (b.neighbours.size < 1) throw new OpError("A lift must connect to at least one other sector.");
  let out = b.room;
  const heights = [...b.neighbours].map((n) => out.sectors[n]!.floorHeight);
  const maxh = Math.max(...heights);
  for (const i of b.borders) {
    const l = out.linedefs[i]!;
    const outside = l.front!;
    const linedefs = out.linedefs.slice();
    linedefs[i] = { ...l, front: { ...outside, below: outside.below || outside.normal, normal: 0 }, back: { ...l.back!, normal: 0 } };
    out = { ...out, linedefs };
  }
  const s = out.sectors[sector]!;
  const sectors = out.sectors.slice();
  const floorHeight = Math.max(s.floorHeight, maxh);
  sectors[sector] = { ...s, floorHeight, ceilingHeight: Math.max(s.ceilingHeight, maxh + 56), serverId: s.serverId || freeSectorServerId(out) };
  return { ...out, sectors };
}

/** roomedit DistributeSectorFloors / Ceilings: even steps from the first selected sector to the last. */
export function distributeHeights(room: RoomSource, indices: readonly number[], which: "floor" | "ceiling"): RoomSource {
  if (indices.length < 3) throw new OpError("Select at least three sectors, in order.");
  const key = which === "floor" ? "floorHeight" : "ceilingHeight";
  const h1 = room.sectors[indices[0]!]![key];
  const h2 = room.sectors[indices[indices.length - 1]!]![key];
  const num = indices.length - 1;
  const sectors = room.sectors.slice();
  indices.forEach((s, n) => {
    sectors[s] = { ...sectors[s]!, [key]: h1 + Math.trunc((n * (h2 - h1)) / num) };
  });
  return { ...room, sectors };
}

/** The vertices around a sector, in linedef order. */
export function sectorVertices(room: RoomSource, sector: number): number[] {
  const out: number[] = [];
  for (const l of room.linedefs) {
    if (l.front?.sector !== sector && l.back?.sector !== sector) continue;
    for (const v of [l.start, l.end]) if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Turn a sloped floor or ceiling on, resting on three of the sector's vertices at its current height. */
export function addSlope(room: RoomSource, sector: number, floor: boolean): RoomSource {
  const verts = sectorVertices(room, sector);
  if (verts.length < 3) throw new OpError(`Sector ${sector} needs at least three vertices for a slope.`);
  const s = room.sectors[sector]!;
  const h = floor ? s.floorHeight : s.ceilingHeight;
  // Pick three spread-out, non-collinear vertices: the first, the farthest from it, and the farthest from that line.
  const p = (v: number): [number, number] => room.vertices[v]!;
  const a = verts[0]!;
  let b = verts[1]!;
  for (const v of verts) if (dist2(p(v), p(a)) > dist2(p(b), p(a))) b = v;
  let c = -1;
  let best = 0;
  for (const v of verts) {
    const area = Math.abs((p(b)[0] - p(a)[0]) * (p(v)[1] - p(a)[1]) - (p(b)[1] - p(a)[1]) * (p(v)[0] - p(a)[0]));
    if (area > best) {
      best = area;
      c = v;
    }
  }
  if (c < 0) throw new OpError(`Sector ${sector}'s vertices are all in a line.`);
  const slope: SourceSlope = { angle: 0, points: [a, b, c].map((v) => [p(v)[0], p(v)[1], h]) as SourceSlope["points"] };
  const sectors = room.sectors.slice();
  sectors[sector] = floor ? { ...s, flags: s.flags | 0x400, floorSlope: slope } : { ...s, flags: s.flags | 0x800, ceilingSlope: slope };
  return { ...room, sectors };
}

const dist2 = (a: [number, number], b: [number, number]): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

// ---------------------------------------------------------------- moving, rotating, copying

/** The vertices an item set drags along. */
export function verticesOf(room: RoomSource, kind: ItemKind, indices: readonly number[]): number[] {
  const out = new Set<number>();
  const set = new Set(indices);
  if (kind === "vertex") indices.forEach((v) => out.add(v));
  else if (kind === "linedef") {
    for (const i of indices) {
      out.add(room.linedefs[i]!.start);
      out.add(room.linedefs[i]!.end);
    }
  } else if (kind === "sector") {
    for (const l of room.linedefs) {
      if ((l.front && set.has(l.front.sector)) || (l.back && set.has(l.back.sector))) {
        out.add(l.start);
        out.add(l.end);
      }
    }
  }
  return [...out];
}

/** Move vertices (and slope points resting on them) or things by (dx, dy). */
export function moveItems(room: RoomSource, kind: ItemKind, indices: readonly number[], dx: number, dy: number): RoomSource {
  if (dx === 0 && dy === 0) return room;
  if (kind === "thing") {
    const things = room.things.slice();
    for (const i of indices) things[i] = { ...things[i]!, x: things[i]!.x + dx, y: things[i]!.y + dy };
    return { ...room, things };
  }
  const verts = verticesOf(room, kind, indices);
  return transformVertices(room, verts, ([x, y]) => [x + dx, y + dy]);
}

function transformVertices(room: RoomSource, verts: readonly number[], f: (p: [number, number]) => [number, number]): RoomSource {
  if (verts.length === 0) return room;
  const vertices = room.vertices.slice();
  const moved = new Map<string, [number, number]>();
  for (const v of new Set(verts)) {
    const before = room.vertices[v]!;
    const after = f(before);
    vertices[v] = after;
    moved.set(`${before[0]},${before[1]}`, after);
  }
  const sectors = room.sectors.map((s) => {
    const fix = (slope: SourceSlope | null): SourceSlope | null => {
      if (!slope || !slope.points.some(([x, y]) => moved.has(`${x},${y}`))) return slope;
      return { ...slope, points: slope.points.map(([x, y, z]) => [...(moved.get(`${x},${y}`) ?? [x, y]), z]) as SourceSlope["points"] };
    };
    const floorSlope = fix(s.floorSlope);
    const ceilingSlope = fix(s.ceilingSlope);
    return floorSlope === s.floorSlope && ceilingSlope === s.ceilingSlope ? s : { ...s, floorSlope, ceilingSlope };
  });
  return { ...room, vertices, sectors };
}

/** roomedit RotateAndScaleObjects: about the centre of the selection; vertices snap to 8 as roomedit does. */
export function rotateScale(room: RoomSource, kind: ItemKind, indices: readonly number[], degrees: number, scale: number, snap8 = true): RoomSource {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotate = (dx: number, dy: number): [number, number] => [Math.round((dx * cos - dy * sin) * scale), Math.round((dx * sin + dy * cos) * scale)];
  if (kind === "thing") {
    if (indices.length === 0) return room;
    const cx = Math.round(indices.reduce((a, i) => a + room.things[i]!.x, 0) / indices.length);
    const cy = Math.round(indices.reduce((a, i) => a + room.things[i]!.y, 0) / indices.length);
    const things = room.things.slice();
    for (const i of indices) {
      const [dx, dy] = rotate(things[i]!.x - cx, things[i]!.y - cy);
      things[i] = { ...things[i]!, x: cx + dx, y: cy + dy };
    }
    return { ...room, things };
  }
  const verts = verticesOf(room, kind, indices);
  if (verts.length === 0) return room;
  const cx = Math.round(verts.reduce((a, v) => a + room.vertices[v]![0], 0) / verts.length);
  const cy = Math.round(verts.reduce((a, v) => a + room.vertices[v]![1], 0) / verts.length);
  const snap = (v: number): number => (snap8 ? (v + 4) & ~7 : v);
  return transformVertices(room, verts, ([x, y]) => {
    const [dx, dy] = rotate(x - cx, y - cy);
    return [snap(cx + dx), snap(cy + dy)];
  });
}

/** Mirror the selection left-right or top-bottom about its centre (flipping linedefs so sides stay inside). */
export function mirror(room: RoomSource, kind: ItemKind, indices: readonly number[], horizontal: boolean): RoomSource {
  const verts = kind === "thing" ? [] : verticesOf(room, kind, indices);
  if (kind === "thing") {
    const xs = indices.map((i) => (horizontal ? room.things[i]!.x : room.things[i]!.y));
    const c = Math.min(...xs) + Math.max(...xs);
    const things = room.things.slice();
    for (const i of indices) things[i] = horizontal ? { ...things[i]!, x: c - things[i]!.x } : { ...things[i]!, y: c - things[i]!.y };
    return { ...room, things };
  }
  if (verts.length === 0) return room;
  const coords = verts.map((v) => room.vertices[v]![horizontal ? 0 : 1]);
  const c = Math.min(...coords) + Math.max(...coords);
  const out = transformVertices(room, verts, ([x, y]) => (horizontal ? [c - x, y] : [x, c - y]));
  // Mirroring reverses winding: swap the ends of every linedef that moved whole, so each side keeps facing its sector.
  const set = new Set(verts);
  return { ...out, linedefs: out.linedefs.map((l) => (set.has(l.start) && set.has(l.end) ? { ...l, start: l.end, end: l.start } : l)) };
}

/** What a copy holds: self-contained geometry with its own sectors. */
export interface Clipboard {
  vertices: [number, number][];
  linedefs: SourceLinedef[];
  sectors: SourceSector[];
  things: SourceThing[];
}

/**
 * roomedit CopyObjects: take the selection's linedefs (and their vertices and
 * sectors) or things. Sides facing sectors outside the copy are dropped.
 */
export function copySelection(room: RoomSource, kind: ItemKind, indices: readonly number[]): Clipboard {
  if (kind === "thing") return { vertices: [], linedefs: [], sectors: [], things: indices.map((i) => room.things[i]!) };
  let lineSet: number[];
  if (kind === "linedef") lineSet = [...indices];
  else if (kind === "sector") {
    const s = new Set(indices);
    lineSet = room.linedefs.flatMap((l, i) => ((l.front && s.has(l.front.sector)) || (l.back && s.has(l.back.sector)) ? [i] : []));
  } else {
    const v = new Set(indices);
    lineSet = room.linedefs.flatMap((l, i) => (v.has(l.start) && v.has(l.end) ? [i] : []));
  }
  const vmap = new Map<number, number>();
  const smap = new Map<number, number>();
  const vertices: [number, number][] = [];
  const sectors: SourceSector[] = [];
  const keepSectors = kind === "sector" ? new Set(indices) : null;
  const sector = (s: number): number => {
    if (!smap.has(s)) {
      smap.set(s, sectors.length);
      sectors.push(room.sectors[s]!);
    }
    return smap.get(s)!;
  };
  const vertex = (v: number): number => {
    if (!vmap.has(v)) {
      vmap.set(v, vertices.length);
      vertices.push(room.vertices[v]!);
    }
    return vmap.get(v)!;
  };
  const side = (s: SourceSide | null): SourceSide | null => {
    if (!s || s.sector < 0) return s;
    if (keepSectors && !keepSectors.has(s.sector)) return null;
    return { ...s, sector: sector(s.sector) };
  };
  if (kind === "vertex") for (const v of indices) vertex(v);
  const linedefs = lineSet.map((i) => {
    const l = room.linedefs[i]!;
    const front = side(l.front);
    const back = side(l.back);
    return front || !back ? { start: vertex(l.start), end: vertex(l.end), front, back } : { start: vertex(l.end), end: vertex(l.start), front: back, back: null };
  });
  return { vertices, linedefs, sectors, things: [] };
}

/** Paste a clipboard shifted by (dx, dy). Returns the room and the new items' indices. */
export function paste(room: RoomSource, clip: Clipboard, dx: number, dy: number): { room: RoomSource; kind: ItemKind; indices: number[] } {
  if (clip.things.length) {
    const start = room.things.length;
    return {
      room: { ...room, things: [...room.things, ...clip.things.map((t) => ({ ...t, x: t.x + dx, y: t.y + dy }))] },
      kind: "thing",
      indices: clip.things.map((_, i) => start + i),
    };
  }
  const v0 = room.vertices.length;
  const s0 = room.sectors.length;
  const l0 = room.linedefs.length;
  const shift = (s: SourceSide | null): SourceSide | null => (s && s.sector >= 0 ? { ...s, sector: s.sector + s0 } : s);
  const out: RoomSource = {
    ...room,
    vertices: [...room.vertices, ...clip.vertices.map(([x, y]) => [x + dx, y + dy] as [number, number])],
    sectors: [...room.sectors, ...clip.sectors.map((s) => shiftSlopes(s, dx, dy))],
    linedefs: [...room.linedefs, ...clip.linedefs.map((l) => ({ start: l.start + v0, end: l.end + v0, front: shift(l.front), back: shift(l.back) }))],
  };
  if (clip.sectors.length) return { room: out, kind: "sector", indices: clip.sectors.map((_, i) => s0 + i) };
  return { room: out, kind: "linedef", indices: clip.linedefs.map((_, i) => l0 + i) };
}

function shiftSlopes(s: SourceSector, dx: number, dy: number): SourceSector {
  const f = (slope: SourceSlope | null): SourceSlope | null =>
    slope && { ...slope, points: slope.points.map(([x, y, z]) => [x + dx, y + dy, z]) as SourceSlope["points"] };
  return { ...s, floorSlope: f(s.floorSlope), ceilingSlope: f(s.ceilingSlope) };
}

// ---------------------------------------------------------------- auto-merge after moving

/**
 * roomedit AutoMergeVertices, run after vertices move: a vertex dropped on
 * another merges into it, one dropped on a linedef splits it there, and
 * linedefs that end up between the same two vertices merge their sides.
 * `moved` are the moved vertices' positions (indices shift as vertices go).
 */
export function autoMerge(room: RoomSource, moved: readonly [number, number][]): RoomSource {
  const keys = new Set(moved.map(([x, y]) => `${x},${y}`));
  let out = room;

  // 1. Same position: keep the vertex that didn't move (or the lower index).
  for (let guard = 0; guard < 10000; guard++) {
    const byPos = new Map<string, number[]>();
    out.vertices.forEach(([x, y], i) => {
      const key = `${x},${y}`;
      if (!keys.has(key)) return;
      byPos.set(key, [...(byPos.get(key) ?? []), i]);
    });
    const dup = [...byPos.values()].find((list) => list.length > 1);
    if (!dup) break;
    out = mergeVertices(out, dup);
  }

  // 2. On a linedef: split it there.
  const w = { vertices: out.vertices.slice(), linedefs: out.linedefs.slice() };
  w.vertices.forEach(([x, y], v) => {
    if (!keys.has(`${x},${y}`)) return;
    for (let i = 0; i < w.linedefs.length; i++) {
      const l = w.linedefs[i]!;
      if (l.start === v || l.end === v) continue;
      const a = w.vertices[l.start]!;
      const b = w.vertices[l.end]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const t = ((x - a[0]) * dx + (y - a[1]) * dy) / len2;
      if (t <= 0 || t >= 1) continue;
      if (Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y) < 0.5) splitLinedefAt(w, i, v);
    }
  });
  out = { ...out, ...w };

  // 3. Superimposed linedefs: fill the first one's missing sides from the other, drop the other.
  const linedefs = out.linedefs.slice();
  const drop = new Set<number>();
  for (let i = 0; i < linedefs.length; i++) {
    if (drop.has(i)) continue;
    for (let j = i + 1; j < linedefs.length; j++) {
      if (drop.has(j)) continue;
      const a = linedefs[i]!;
      const b = linedefs[j]!;
      const same = a.start === b.start && a.end === b.end;
      const flipped = a.start === b.end && a.end === b.start;
      if (!same && !flipped) continue;
      linedefs[i] = {
        ...a,
        front: a.front ?? (flipped ? b.back : b.front),
        back: a.back ?? (flipped ? b.front : b.back),
      };
      drop.add(j);
    }
  }
  if (drop.size) out = { ...out, linedefs: linedefs.filter((_, i) => !drop.has(i)) };
  return out;
}

/** roomedit's Insert in vertex mode: a lone vertex (on a linedef, if it lands on one). */
export function addVertex(room: RoomSource, x: number, y: number): { room: RoomSource; vertex: number } {
  const existing = room.vertices.findIndex(([vx, vy]) => vx === x && vy === y);
  if (existing >= 0) return { room, vertex: existing };
  const added: RoomSource = { ...room, vertices: [...room.vertices, [x, y]] };
  const out = autoMerge(added, [[x, y]]);
  return { room: out, vertex: out.vertices.findIndex(([vx, vy]) => vx === x && vy === y) };
}

// ---------------------------------------------------------------- roomedit's Insert key

/**
 * roomedit's first Insert special case: linedefs between the selected
 * vertices, in order (and back to the first if `closed`). No sides yet.
 */
export function linkVertices(room: RoomSource, vertices: readonly number[], closed: boolean): { room: RoomSource; linedefs: number[] } {
  if (vertices.length < 2) throw new OpError("Select at least two vertices, in order.");
  const linedefs = room.linedefs.slice();
  const out: number[] = [];
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < vertices.length; i++) pairs.push([vertices[i]!, vertices[i + 1]!]);
  if (closed && vertices.length > 2) pairs.push([vertices[vertices.length - 1]!, vertices[0]!]);
  for (const [a, b] of pairs) {
    const existing = linedefs.findIndex((l) => (l.start === a && l.end === b) || (l.start === b && l.end === a));
    if (existing >= 0) out.push(existing);
    else {
      linedefs.push({ start: a, end: b, front: null, back: null });
      out.push(linedefs.length - 1);
    }
  }
  return { room: { ...room, linedefs }, linedefs: out };
}

/**
 * roomedit's second Insert special case: a new sector on the free side of
 * each selected linedef. A linedef that already has a front gets a back
 * (becoming two-sided, losing its normal texture); the new sector copies the
 * sector that front faced.
 */
export function makeSectorFromLinedefs(room: RoomSource, indices: readonly number[], defaults: DrawDefaults): { room: RoomSource; sector: number } {
  if (indices.length === 0) throw new OpError("Select the linedefs around the new sector.");
  for (const i of indices) {
    const l = room.linedefs[i]!;
    if (l.front && l.back) throw new OpError(`Linedef ${i} already has two sides.`);
  }
  const sectors = room.sectors.slice();
  const template = indices.map((i) => room.linedefs[i]!.front?.sector ?? -1).find((s) => s >= 0);
  sectors.push(
    template !== undefined
      ? { ...sectors[template]!, flags: sectors[template]!.flags & ~SLOPED, floorSlope: null, ceilingSlope: null }
      : {
          serverId: 0,
          floorTexture: defaults.floorTexture,
          ceilingTexture: defaults.ceilingTexture,
          floorHeight: defaults.floorHeight,
          ceilingHeight: defaults.ceilingHeight,
          xOffset: 0,
          yOffset: 0,
          light: defaults.light,
          flags: 0,
          animateSpeed: 0,
          floorSlope: null,
          ceilingSlope: null,
        },
  );
  const sector = sectors.length - 1;
  const linedefs = room.linedefs.slice();
  const fresh = (): SourceSide => ({ sector, normal: defaults.wallTexture, above: defaults.upperTexture, below: defaults.lowerTexture, xOffset: 0, yOffset: 0, serverId: 0, animateSpeed: 0, flags: 0 });
  for (const i of indices) {
    const l = linedefs[i]!;
    if (l.front) {
      const tex = l.front.normal;
      linedefs[i] = {
        ...l,
        front: { ...l.front, normal: 0, above: l.front.above || tex, below: l.front.below || tex },
        back: { ...fresh(), normal: 0, above: tex, below: tex },
      };
    } else {
      linedefs[i] = { ...l, front: fresh() };
    }
  }
  return { room: { ...room, linedefs, sectors }, sector };
}

// ---------------------------------------------------------------- things and new rooms

export const THING_TYPES = [
  { value: 0, label: "Room box corner (player blocking)" },
  { value: 1, label: "Exit" },
  { value: 2, label: "Monster generator" },
  { value: 3, label: "Entrance" },
  { value: 4, label: "Extra pre-object 2" },
  { value: 5, label: "Extra pre-object 3" },
  { value: 6, label: "Extra pre-object 4" },
  { value: 7, label: "Object (Kod class)" },
] as const;

export function addThing(room: RoomSource, x: number, y: number, copyFrom?: number): RoomSource {
  const base: SourceThing = copyFrom !== undefined && room.things[copyFrom] ? { ...room.things[copyFrom]! } : { x, y, type: 7, angle: 0, when: 0, xExit: 0, yExit: 0, flags: 0, comment: "" };
  return { ...room, things: [...room.things, { ...base, x, y }] };
}

/** A new empty room: a room box and nothing else. */
export function newRoom(widthSquares = 16, heightSquares = 16): RoomSource {
  return {
    format: "meridian-room",
    formatVersion: 1,
    roomId: 0,
    vertices: [],
    linedefs: [],
    sectors: [],
    things: [
      { x: 0, y: heightSquares * 64 },
      { x: widthSquares * 64, y: 0 },
    ],
  };
}

/** A room drawn as one rectangle filling the box, for a quick start. */
export function newRoomWithFloor(widthSquares: number, heightSquares: number, defaults: DrawDefaults): RoomSource {
  const room = newRoom(widthSquares, heightSquares);
  const w = widthSquares * 64;
  const h = heightSquares * 64;
  return insertPath(
    room,
    [
      [0, 0],
      [0, h],
      [w, h],
      [w, 0],
    ],
    true,
    defaults,
  ).room;
}

export type { SourceLinedef };
