// Draws Shards' admin test room, the Proving Grounds (RID 4300), with the editor's
// own operations, and writes it to Shards' room sources (shardsPaths.ts):
// shards-server's resource/rooms/src/provgrnd.room.json. Its Kod class is
// kod/object/active/holder/room/provgrnd.kod there, which says what each zone is for.
//
//   node tools/shards/make-provgrnd.ts
//
// 32 × 24 squares under open sky (Kod rows and cols, 1-based):
//   the pen          rows 2-10, cols 2-14: earth, with five spawn pads
//   the spell range  rows 2-10, cols 18-31: a casting mark at row 6, col 19
//   the terrain      rows 14-17: grass, earth, rocky, cobbles, shallow water, deep water,
//                    painted water (a water texture on a dry floor), grass
//   the hall         rows 19-23, cols 2-31: roofed
//   the exits        row 12 (Tos) and row 13 (the God room), at col 2
// Floor textures are the asset build's (floortextures.json, watertextures.json), so
// Ground Detail, critters, fish and puddles each find their kind of ground.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatRoomSource, type RoomSource } from "@meridian-editor/roomc";
import { ROOMEDIT_DEFAULTS, type DrawDefaults } from "../../apps/editor/src/renderer/ops/draw.ts";
import { newRoomWithFloor } from "../../apps/editor/src/renderer/ops/edit.ts";
import type { Pt } from "../../apps/editor/src/renderer/ops/geom.ts";
import { insertShape, rectanglePoints } from "../../apps/editor/src/renderer/ops/shapes.ts";
import { shardsPaths } from "../../apps/editor/src/main/shardsPaths.ts";

const COLS = 32;
const ROWS = 24;
const H = ROWS * 64;

const TEX = {
  street: 4600, // earth, cobbled
  wall: 4713,
  pen: 2103, // earth
  pad: 2014, // rocky, cobbled: stands out
  range: 4508,
  grass: 2001,
  earth: 2103,
  rocky: 1602,
  cobbles: 4604,
  water: 1802,
  grass2: 2301,
  hallFloor: 4602,
  hallCeiling: 4607,
} as const;

/** proto.h SF_DEPTH1 / SF_DEPTH2: shallow and deep water (the low two bits of a sector's flags) */
const DEPTH = { shallow: 1, deep: 2 } as const;

const D: DrawDefaults = {
  ...ROOMEDIT_DEFAULTS,
  floorHeight: 0,
  // Open sky: no ceiling texture, and walls tall enough to look like a yard's
  ceilingHeight: 320,
  floorTexture: TEX.street,
  ceilingTexture: 0,
  light: 192,
  wallTexture: TEX.wall,
  upperTexture: TEX.wall,
  lowerTexture: TEX.wall,
  passable: true,
};

/** The editor rectangle covering Kod squares rows r0..r1, cols c0..c1 (1-based, inclusive). */
function squares(r0: number, c0: number, r1: number, c1: number): Pt[] {
  return rectanglePoints((c0 - 1) * 64, H - r1 * 64, c1 * 64, H - (r0 - 1) * 64);
}

let room: RoomSource = { ...newRoomWithFloor(COLS, ROWS, D), roomId: 4300 };

/** Draws a rectangle of squares and gives the sector it makes these fields. */
function area(r0: number, c0: number, r1: number, c1: number, patch: Partial<RoomSource["sectors"][number]>): void {
  const r = insertShape(room, squares(r0, c0, r1, c1), D);
  room = r.room;
  const s = r.sectors[0];
  if (s === undefined) throw new Error(`rows ${r0}-${r1}, cols ${c0}-${c1} made no sector`);
  const sectors = room.sectors.slice();
  sectors[s] = { ...sectors[s]!, ...patch };
  room = { ...room, sectors };
}

// The pen and its spawn pads (provgrnd.kod plPads, in the same order)
area(2, 2, 10, 14, { floorTexture: TEX.pen });
for (const [r, c] of [
  [4, 4],
  [4, 12],
  [8, 4],
  [8, 12],
  [6, 8],
] as const) {
  area(r, c, r, c, { floorTexture: TEX.pad });
}

// The spell range and its casting mark (the dummies stand 2, 5 and 10 squares east of it)
area(2, 18, 10, 31, { floorTexture: TEX.range });
area(6, 19, 6, 19, { floorTexture: TEX.pad });

// The terrain strip, west to east
const strip: [number, number, Partial<RoomSource["sectors"][number]>][] = [
  [2, 5, { floorTexture: TEX.grass }],
  [6, 9, { floorTexture: TEX.earth }],
  [10, 13, { floorTexture: TEX.rocky }],
  [14, 17, { floorTexture: TEX.cobbles }],
  [18, 21, { floorTexture: TEX.water, flags: DEPTH.shallow }],
  [22, 25, { floorTexture: TEX.water, flags: DEPTH.deep }],
  [26, 29, { floorTexture: TEX.water }],
  [30, 31, { floorTexture: TEX.grass2 }],
];
for (const [c0, c1, patch] of strip) area(14, c0, 17, c1, patch);

// The hall: roofed and dimmer
area(19, 2, 23, 31, { floorTexture: TEX.hallFloor, ceilingTexture: TEX.hallCeiling, ceilingHeight: 192, light: 140 });

// The exits' squares, marked like the pads
area(12, 2, 12, 2, { floorTexture: TEX.pad });
area(13, 2, 13, 2, { floorTexture: TEX.pad });

const paths = shardsPaths(resolve(import.meta.dirname, "../.."));
if (!paths) throw new Error("No Shards checkout beside this repo (meridian-browser/server/src): set MERIDIAN_BROWSER or SHARDS_SERVER");
const out = join(paths.rooms, "provgrnd.room.json");
writeFileSync(out, formatRoomSource(room));
console.log(`provgrnd: ${room.vertices.length} vertices, ${room.linedefs.length} linedefs, ${room.sectors.length} sectors -> ${out}`);
