// The room source: what the editor works on and what gets committed. It holds
// roomedit's editing model (vertices, linedefs with their two sides, sectors,
// things), not the compiled BSP. Coordinates are editor units: 64 per grid
// square, y up. `roomc compile` turns it into a .roo for one target.
//
// Values are kept as roomedit stores them, so import → compile reproduces a
// shipped room byte for byte: side flags are the raw WF_* bits for that side,
// slope angles are client units (4096 per circle).

import type { TargetProfile } from "@meridian-editor/roo";
import { SF } from "@meridian-editor/roo";

export const ROOM_SOURCE_FORMAT = "meridian-room";
export const ROOM_SOURCE_VERSION = 1;

export interface RoomSource {
  format: typeof ROOM_SOURCE_FORMAT;
  formatVersion: number;
  /** The RID Kod refers to the room by; 0 if unset. */
  roomId: number;
  /** [x, y] pairs. */
  vertices: [number, number][];
  linedefs: SourceLinedef[];
  sectors: SourceSector[];
  /**
   * The first two are the corners of the room box, which sets the room size
   * and the Kod row/col origin. 104 loads only rooms with exactly two.
   */
  things: SourceThing[];
  /**
   * Quirks of older roomedit builds, detected on import so a shipped room
   * recompiles byte for byte. Leave unset for new rooms.
   */
  compat?: SourceCompat;
}

export interface SourceCompat {
  /** Editor walls repeat the front side's offsets in a missing back side's slots (editor section only). */
  mirrorMissingBackOffsets?: boolean;
  /** BSP wall flips leave the y offsets in place (older bspmake.cpp BSPFlipWall). */
  flipKeepsYOffsets?: boolean;
  /** Slope planes computed in float rather than double (older ComputeSlopeInfo). */
  floatSlopes?: boolean;
}

export interface SourceLinedef {
  /** Vertex indices. */
  start: number;
  end: number;
  /** The + side (roomedit sidedef1), on the right going from start to end. */
  front: SourceSide | null;
  /** The − side (roomedit sidedef2). */
  back: SourceSide | null;
}

export interface SourceSide {
  /** Sector index; -1 = none. */
  sector: number;
  /** Texture numbers (grdNNNNN.bgf); 0 = none. */
  normal: number;
  above: number;
  below: number;
  xOffset: number;
  yOffset: number;
  /** server_id Kod uses for AnimateWall / ChangeTexture. */
  serverId: number;
  animateSpeed: number;
  /** WF_* bits for this side, including scroll, map and (original only) translucency / no-htile bits. */
  flags: number;
}

export interface SourceSector {
  /** server_id Kod uses for SetSector / SetSectorLight. */
  serverId: number;
  floorTexture: number;
  ceilingTexture: number;
  floorHeight: number;
  ceilingHeight: number;
  xOffset: number;
  yOffset: number;
  light: number;
  /** SF_* bits. Unknown bits (such as 104's 0x2000) are kept as-is. */
  flags: number;
  animateSpeed: number;
  floorSlope: SourceSlope | null;
  ceilingSlope: SourceSlope | null;
}

export interface SourceSlope {
  /** Texture direction, client angle units (4096 per circle). */
  angle: number;
  /** Three points [x, y, z] in editor units; x, y should be vertices. The first is the texture origin. */
  points: [[number, number, number], [number, number, number], [number, number, number]];
}

export interface SourceThing {
  x: number;
  y: number;
  /** The rest only matter when a room has more than two things (roomedit's full record). */
  type?: number;
  angle?: number;
  when?: number;
  xExit?: number;
  yExit?: number;
  flags?: number;
  comment?: string;
}

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
}

/** Structural checks, plus what the target can't store when a profile is given. */
export function validateSource(src: RoomSource, profile?: TargetProfile): Diagnostic[] {
  const out: Diagnostic[] = [];
  const error = (message: string): void => void out.push({ severity: "error", message });
  const warn = (message: string): void => void out.push({ severity: "warning", message });

  if (src.format !== ROOM_SOURCE_FORMAT) error(`format is "${String(src.format)}", expected "${ROOM_SOURCE_FORMAT}"`);
  if (src.formatVersion !== ROOM_SOURCE_VERSION) error(`formatVersion ${src.formatVersion} is not supported (expected ${ROOM_SOURCE_VERSION})`);

  const short = (v: number): boolean => Number.isInteger(v) && v >= -32768 && v <= 32767;
  src.vertices.forEach(([x, y], i) => {
    if (!short(x) || !short(y)) error(`vertex ${i} (${x}, ${y}) is outside the 16-bit editor range`);
  });

  const nv = src.vertices.length;
  const ns = src.sectors.length;
  src.linedefs.forEach((l, i) => {
    if (!(l.start >= 0 && l.start < nv && l.end >= 0 && l.end < nv)) {
      error(`linedef ${i} uses a vertex out of range`);
      return;
    }
    const [x0, y0] = src.vertices[l.start]!;
    const [x1, y1] = src.vertices[l.end]!;
    if (x0 === x1 && y0 === y1) warn(`linedef ${i} has zero length; it is left out of the BSP`);
    if (!l.front && !l.back) warn(`linedef ${i} has no sides`);
    for (const [name, side] of [["front", l.front], ["back", l.back]] as const) {
      if (!side) continue;
      if (side.sector < -1 || side.sector >= ns) error(`linedef ${i} ${name} side uses sector ${side.sector} of ${ns}`);
      if (profile) {
        const extra = side.flags & ~profile.wallFlagMask;
        if (extra) error(`linedef ${i} ${name} side uses wall flags 0x${(extra >>> 0).toString(16)} that ${profile.name} doesn't support`);
      }
    }
  });

  src.sectors.forEach((s, i) => {
    if (s.flags & SF.SLOPED_FLOOR && !s.floorSlope) error(`sector ${i} is flagged sloped floor but has no floorSlope`);
    if (s.flags & SF.SLOPED_CEILING && !s.ceilingSlope) error(`sector ${i} is flagged sloped ceiling but has no ceilingSlope`);
    for (const slope of [s.floorSlope, s.ceilingSlope]) {
      if (!slope) continue;
      for (const [x, y] of slope.points) {
        if (!src.vertices.some(([vx, vy]) => vx === x && vy === y)) {
          warn(`sector ${i} slope point (${x}, ${y}) is not a vertex`);
        }
      }
    }
    if (profile && !profile.allowNegativeHeights && (s.floorHeight < 0 || s.ceilingHeight < 0)) {
      error(`sector ${i} has a negative height (${s.floorHeight}/${s.ceilingHeight}); ${profile.name} reads heights as unsigned`);
    }
  });

  if (src.things.length < 2) warn(`only ${src.things.length} things; the room box falls back to the map bounds`);
  if (profile?.exactlyTwoThings && src.things.length !== 2) {
    error(`${profile.name} needs exactly 2 things (the room box corners), found ${src.things.length}`);
  }
  return out;
}
