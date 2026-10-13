// Draws the in-game test room with the editor's own operations, as a person
// would with the Rectangle tool, and writes rooms/new/edtest.room.json.
//
//   node tools/shards/make-edtest.ts
//
// The room is 16 × 12 squares. Each feature tests one rule of 104's movement
// check (s:blakserv/roofile.c BSPCanMoveInRoomTreeInternal):
//   platform  floor 16: a step up (≤ 24, MAXSTEPHEIGHT) you can walk onto
//   ledge     floor 64: too high to step onto
//   ramp      a sloped floor from 0 up to the ledge: the way up
//   tunnel    ceiling 40: too low to walk under (OBJECTHEIGHTROO is 48)
//   pillar    one-sided walls: solid
// rooms/new/edtest.walk.json walks through each of them on the server.

import { writeFileSync } from "node:fs";
import { formatRoomSource, type RoomSource } from "@meridian-editor/roomc";
import { ROOMEDIT_DEFAULTS, type DrawDefaults } from "../../apps/editor/src/renderer/ops/draw.ts";
import { addSlope, newRoomWithFloor } from "../../apps/editor/src/renderer/ops/edit.ts";
import type { Pt } from "../../apps/editor/src/renderer/ops/geom.ts";
import { insertShape, rectanglePoints } from "../../apps/editor/src/renderer/ops/shapes.ts";

const COLS = 16;
const ROWS = 12;
const H = ROWS * 64;

// Textures from Marion's inn (marinn.roo).
const D: DrawDefaults = {
  ...ROOMEDIT_DEFAULTS,
  floorHeight: 0,
  ceilingHeight: 160,
  floorTexture: 2011,
  ceilingTexture: 4607,
  light: 160,
  wallTexture: 4713,
  upperTexture: 4610,
  lowerTexture: 3102,
  passable: true,
};

/** The editor rectangle covering Kod squares rows r0..r1, cols c0..c1 (1-based, inclusive). */
function squares(r0: number, c0: number, r1: number, c1: number): Pt[] {
  return rectanglePoints((c0 - 1) * 64, H - r1 * 64, c1 * 64, H - (r0 - 1) * 64);
}

function sectorInside(created: number[]): number {
  const s = created[0];
  if (s === undefined) throw new Error("the shape made no sector");
  return s;
}

let room = newRoomWithFloor(COLS, ROWS, D);
room = { ...room, roomId: 4200 };

const set = (index: number, patch: Partial<RoomSource["sectors"][number]>): void => {
  const sectors = room.sectors.slice();
  sectors[index] = { ...sectors[index]!, ...patch };
  room = { ...room, sectors };
};

// Platform: rows 2-4, cols 3-5, a 16-unit step.
let r = insertShape(room, squares(2, 3, 4, 5), D);
room = r.room;
set(sectorInside(r.sectors), { floorHeight: 16, floorTexture: 3101 });

// Ledge: rows 2-5, cols 11-15, 64 up.
r = insertShape(room, squares(2, 11, 5, 15), D);
room = r.room;
set(sectorInside(r.sectors), { floorHeight: 64, floorTexture: 3101 });

// Ramp: rows 6-9, cols 11-15, from 0 at its south edge to 64 where it meets the ledge.
r = insertShape(room, squares(6, 11, 9, 15), D);
room = r.room;
const ramp = sectorInside(r.sectors);
room = addSlope(room, ramp, true);
{
  const s = room.sectors[ramp]!;
  const south = H - 9 * 64;
  const points = s.floorSlope!.points.map(([x, y]) => [x, y, Math.round(((y - south) / 256) * 64)]) as NonNullable<typeof s.floorSlope>["points"];
  set(ramp, { floorHeight: 0, floorSlope: { ...s.floorSlope!, points } });
}

// Tunnel: rows 8-10, cols 3-5, ceiling 40.
r = insertShape(room, squares(8, 3, 10, 5), D);
room = r.room;
set(sectorInside(r.sectors), { ceilingHeight: 40, ceilingTexture: 4610 });

// Pillar: rows 6-7, cols 7-8.
room = insertShape(room, squares(6, 7, 7, 8), D, true).room;

writeFileSync(new URL("../../rooms/new/edtest.room.json", import.meta.url), formatRoomSource(room));
console.log(`edtest: ${room.vertices.length} vertices, ${room.linedefs.length} linedefs, ${room.sectors.length} sectors`);
