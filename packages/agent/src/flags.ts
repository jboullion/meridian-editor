// Wall and sector flags by name, so agents never do bit arithmetic. Named bits
// come from @meridian-editor/roo; multi-bit fields (scroll speed and direction,
// depth, translucency) are numbers.

import { SF, WF } from "@meridian-editor/roo";

export const WALL_FLAGS = {
  backwards: WF.BACKWARDS,
  transparent: WF.TRANSPARENT,
  passable: WF.PASSABLE,
  mapNever: WF.MAP_NEVER,
  mapAlways: WF.MAP_ALWAYS,
  noLookThrough: WF.NOLOOKTHROUGH,
  aboveBottomUp: WF.ABOVE_BOTTOMUP,
  belowTopDown: WF.BELOW_TOPDOWN,
  normalTopDown: WF.NORMAL_TOPDOWN,
  noVTile: WF.NO_VTILE,
  noHTile: WF.NO_HTILE,
} as const;

export const SECTOR_FLAGS = {
  scrollFloor: SF.SCROLL_FLOOR,
  scrollCeiling: SF.SCROLL_CEILING,
  flicker: SF.FLICKER,
  slopedFloor: SF.SLOPED_FLOOR,
  slopedCeiling: SF.SLOPED_CEILING,
} as const;

interface Field {
  mask: number;
  shift: number;
  max: number;
}

export const WALL_FIELDS: Record<string, Field> = {
  scrollSpeed: { mask: WF.SCROLL_SPEED_MASK, shift: 10, max: 3 },
  scrollDirection: { mask: WF.SCROLL_DIRECTION_MASK, shift: 12, max: 7 },
  translucency: { mask: WF.TRANSLUCENCY_MASK, shift: 15, max: 3 },
};

export const SECTOR_FIELDS: Record<string, Field> = {
  depth: { mask: SF.DEPTH_MASK, shift: 0, max: 3 },
  scrollSpeed: { mask: SF.SCROLL_SPEED_MASK, shift: 2, max: 3 },
  scrollDirection: { mask: SF.SCROLL_DIRECTION_MASK, shift: 4, max: 7 },
};

export type FlagSet = "wall" | "sector";

const tables = (set: FlagSet): { names: Record<string, number>; fields: Record<string, Field> } =>
  set === "wall" ? { names: WALL_FLAGS, fields: WALL_FIELDS } : { names: SECTOR_FLAGS, fields: SECTOR_FIELDS };

/** Flags as names and fields; bits nothing names are kept as `otherBits`. */
export function describeFlags(set: FlagSet, flags: number): Record<string, unknown> {
  const { names, fields } = tables(set);
  const on = Object.entries(names).flatMap(([n, bit]) => (flags & bit ? [n] : []));
  const out: Record<string, unknown> = { raw: flags, on };
  let known = 0;
  for (const bit of Object.values(names)) known |= bit;
  for (const [n, f] of Object.entries(fields)) {
    known |= f.mask;
    const v = (flags & f.mask) >>> f.shift;
    if (v) out[n] = v;
  }
  const other = flags & ~known;
  if (other) out.otherBits = `0x${(other >>> 0).toString(16)}`;
  return out;
}

/** Turn named flags on or off and set fields, leaving the other bits alone. */
export function changeFlags(set: FlagSet, flags: number, on: readonly string[], off: readonly string[], values: Record<string, number>): number {
  const { names, fields } = tables(set);
  const bit = (n: string): number => {
    const b = (names as Record<string, number>)[n];
    if (b === undefined) throw new Error(`Unknown ${set} flag "${n}". Known: ${Object.keys(names).join(", ")}.`);
    return b;
  };
  for (const n of on) flags |= bit(n);
  for (const n of off) flags &= ~bit(n);
  for (const [n, v] of Object.entries(values)) {
    const f = fields[n];
    if (!f) throw new Error(`Unknown ${set} field "${n}". Known: ${Object.keys(fields).join(", ")}.`);
    if (!Number.isInteger(v) || v < 0 || v > f.max) throw new Error(`${n} is 0–${f.max}.`);
    flags = (flags & ~f.mask) | (v << f.shift);
  }
  return flags;
}
