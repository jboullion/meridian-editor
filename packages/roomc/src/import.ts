// .roo → room source, the way roomedit reopens a room (roomedit/source/load.cpp
// LoadRoom): rebuild vertices and linedefs from the editor-wall section, attach
// the file sidedefs to each side, and copy sectors and things.

import type { RooFile, Slope } from "@meridian-editor/roo";
import { computeSlope, sameStoredPlane, slopeFrame } from "./slope.ts";
import {
  ROOM_SOURCE_FORMAT,
  ROOM_SOURCE_VERSION,
  type RoomSource,
  type SourceCompat,
  type SourceSide,
  type SourceSlope,
  type SourceThing,
} from "./source.ts";

/** C SHORT conversion: load.cpp reads i32 coordinates into SHORTs. */
const toShort = (v: number): number => (v << 16) >> 16;

export function importRoo(file: RooFile): RoomSource {
  const vertices: [number, number][] = [];
  const vertexIndex = new Map<string, number>();
  const addVertex = (x: number, y: number): number => {
    const key = `${x},${y}`;
    let i = vertexIndex.get(key);
    if (i === undefined) {
      i = vertices.length;
      vertices.push([x, y]);
      vertexIndex.set(key, i);
    }
    return i;
  };

  const linedefs = file.editorWalls.map((w) => {
    const start = addVertex(toShort(w.x0), toShort(w.y0));
    const end = addVertex(toShort(w.x1), toShort(w.y1));
    const side = (fileSidedef: number, sector: number, xOffset: number, yOffset: number): SourceSide | null => {
      if (fileSidedef === 0) return null;
      const sd = file.sidedefs[fileSidedef - 1];
      if (!sd) throw new Error(`editor wall refers to sidedef ${fileSidedef} of ${file.sidedefs.length}`);
      return {
        sector,
        normal: sd.normal,
        above: sd.above,
        below: sd.below,
        xOffset,
        yOffset,
        serverId: sd.id,
        animateSpeed: sd.animateSpeed,
        flags: sd.flags,
      };
    };
    return {
      start,
      end,
      front: side(w.sidedef1, w.sector1, w.xOffset1, w.yOffset1),
      back: side(w.sidedef2, w.sector2, w.xOffset2, w.yOffset2),
    };
  });

  const slope = (s: Slope | null): SourceSlope | null =>
    s && {
      angle: s.angle,
      points: [
        [s.points[0].x, s.points[0].y, s.points[0].z],
        [s.points[1].x, s.points[1].y, s.points[1].z],
        [s.points[2].x, s.points[2].y, s.points[2].z],
      ],
    };

  const sectors = file.sectors.map((s) => ({
    serverId: s.userId,
    floorTexture: s.floorTexture,
    ceilingTexture: s.ceilingTexture,
    floorHeight: s.floorHeight,
    ceilingHeight: s.ceilingHeight,
    xOffset: s.xOffset,
    yOffset: s.yOffset,
    light: s.light,
    flags: s.flags,
    animateSpeed: s.animateSpeed,
    floorSlope: slope(s.floorSlope),
    ceilingSlope: slope(s.ceilingSlope),
  }));

  const things: SourceThing[] =
    file.things.format === "corners"
      ? file.things.things.map((t) => ({ x: t.x, y: t.y }))
      : file.things.things.map((t) => ({
          x: t.x,
          y: t.y,
          type: t.type,
          angle: t.angle,
          when: t.when,
          xExit: t.xExit,
          yExit: t.yExit,
          flags: t.flags,
          comment: cString(t.comment),
        }));

  const room: RoomSource = {
    format: ROOM_SOURCE_FORMAT,
    formatVersion: ROOM_SOURCE_VERSION,
    roomId: file.roomId ?? 0,
    vertices,
    linedefs,
    sectors,
    things,
  };
  const compat: SourceCompat = {};
  if (mirrorsMissingBackOffsets(file)) compat.mirrorMissingBackOffsets = true;
  if (usesFloatSlopes(file, room)) compat.floatSlopes = true;
  if (Object.keys(compat).length) room.compat = compat;
  return room;
}

/**
 * Some shipped 104 rooms were last saved by a roomedit that computed slope
 * planes in float. Use float if double misses a stored plane that float hits.
 */
function usesFloatSlopes(file: RooFile, room: RoomSource): boolean {
  const frame = slopeFrame(room.vertices, room.things);
  let floatOnly = false;
  file.sectors.forEach((s, i) => {
    const src = room.sectors[i]!;
    for (const [stored, slope, floor] of [
      [s.floorSlope, src.floorSlope, true],
      [s.ceilingSlope, src.ceilingSlope, false],
    ] as const) {
      if (!stored || !slope) continue;
      const asDouble = computeSlope(slope, floor, frame, false);
      if (asDouble && sameStoredPlane(asDouble, stored)) continue;
      const asFloat = computeSlope(slope, floor, frame, true);
      if (asFloat && sameStoredPlane(asFloat, stored)) floatOnly = true;
    }
  });
  return floatOnly;
}

/**
 * Some shipped 104 rooms were saved by a roomedit that wrote the front side's
 * offsets into a missing back side's slots. Each room does it everywhere or
 * nowhere, so one non-zero mirrored wall decides it.
 */
function mirrorsMissingBackOffsets(file: RooFile): boolean {
  let mirrored = false;
  for (const w of file.editorWalls) {
    if (w.sidedef2 !== 0 || (w.xOffset1 === 0 && w.yOffset1 === 0)) continue;
    if (w.xOffset2 !== w.xOffset1 || w.yOffset2 !== w.yOffset1) return false;
    mirrored = true;
  }
  return mirrored;
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder("latin1").decode(end < 0 ? bytes : bytes.subarray(0, end));
}
