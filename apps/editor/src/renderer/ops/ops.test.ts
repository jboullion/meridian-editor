import { describe, expect, it } from "vitest";
import { PROFILES } from "@meridian-editor/roo";
import { compileRoom, type RoomSource } from "@meridian-editor/roomc";
import { checkCrossReferences, checkSectors } from "./checks.ts";
import { insertPath, ROOMEDIT_DEFAULTS } from "./draw.ts";
import {
  addSlope,
  addVertex,
  alignTexturesX,
  autoMerge,
  moveItems,
  copySelection,
  deleteItems,
  deleteLinedefsJoinSectors,
  deleteVertexJoinLinedefs,
  distributeHeights,
  flipLinedefs,
  loopFrom,
  makeDoor,
  mergeSectors,
  mergeVertices,
  mirror,
  newRoom,
  newRoomWithFloor,
  paste,
  rotateScale,
  splitLinedefs,
} from "./edit.ts";
import { sectorAtPoint } from "./geom.ts";
import { circleSides, insertShape, insertTorch, polygonPoints, rectanglePoints } from "./shapes.ts";

const D = { ...ROOMEDIT_DEFAULTS, wallTexture: 100, floorTexture: 5 };

function closed(room: RoomSource): string[] {
  return checkSectors(room).map((i) => i.message);
}

function compiles(room: RoomSource): void {
  const result = compileRoom(room, PROFILES["104"]);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(compileRoom(room, PROFILES.original).file.server).not.toBeNull();
}

describe("drawing", () => {
  it("draws a room in empty space", () => {
    const room = insertPath(newRoom(), rectanglePoints(0, 0, 256, 256), true, D).room;
    expect(room.sectors).toHaveLength(1);
    expect(room.linedefs).toHaveLength(4);
    expect(room.linedefs.every((l) => l.front?.sector === 0 && !l.back && l.front.normal === 100)).toBe(true);
    expect(sectorAtPoint(room, 128, 128)).toBe(0);
    expect(sectorAtPoint(room, 300, 128)).toBeNull();
    expect(closed(room)).toEqual([]);
    compiles(room);
  });

  it("draws the same room either way round", () => {
    const pts = rectanglePoints(0, 0, 256, 256).reverse();
    const room = insertPath(newRoom(), pts, true, D).room;
    expect(room.linedefs.every((l) => l.front?.sector === 0 && !l.back)).toBe(true);
    expect(closed(room)).toEqual([]);
  });

  it("splits a sector with a line across it", () => {
    const base = newRoomWithFloor(4, 4, D);
    const { room, sectors } = insertPath(
      base,
      [
        [0, 128],
        [256, 128],
      ],
      false,
      D,
    );
    expect(sectors).toHaveLength(1);
    expect(room.sectors).toHaveLength(2);
    // The new line is two-sided between the halves, with no normal texture.
    const cut = room.linedefs.find((l) => l.front && l.back)!;
    expect(cut.front!.normal).toBe(0);
    expect(new Set([cut.front!.sector, cut.back!.sector])).toEqual(new Set([0, 1]));
    expect(sectorAtPoint(room, 64, 64)).not.toBe(sectorAtPoint(room, 64, 200));
    expect(closed(room)).toEqual([]);
    compiles(room);
  });

  it("splits with a line drawn through and past the walls", () => {
    const base = newRoomWithFloor(4, 4, D);
    const { room } = insertPath(
      base,
      [
        [-64, 128],
        [320, 128],
      ],
      false,
      D,
    );
    expect(room.sectors).toHaveLength(2);
    // The stubs outside the room have no sides.
    expect(room.linedefs.filter((l) => !l.front && !l.back)).toHaveLength(2);
    expect(checkSectors(room).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("draws an inner sector inside another", () => {
    const base = newRoomWithFloor(8, 8, D);
    const { room, sectors } = insertPath(base, rectanglePoints(128, 128, 384, 384), true, D);
    expect(sectors).toEqual([1]);
    const inner = room.linedefs.slice(4);
    expect(inner.every((l) => l.front?.sector === 1 && l.back?.sector === 0)).toBe(true);
    expect(sectorAtPoint(room, 256, 256)).toBe(1);
    expect(sectorAtPoint(room, 32, 32)).toBe(0);
    expect(closed(room)).toEqual([]);
    compiles(room);
  });

  it("draws a pillar inside a sector", () => {
    const base = newRoomWithFloor(8, 8, D);
    const { room } = insertShape(base, rectanglePoints(128, 128, 256, 256), D, true);
    expect(room.sectors).toHaveLength(1);
    const pillar = room.linedefs.slice(4);
    expect(pillar.every((l) => l.front?.sector === 0 && !l.back)).toBe(true);
    // Solid walls: the wall texture, and not passable.
    expect(pillar.every((l) => l.front!.normal === 100 && !(l.front!.flags & 4))).toBe(true);
    expect(sectorAtPoint(room, 192, 192)).toBeNull();
    expect(closed(room)).toEqual([]);
    compiles(room);
  });

  it("adds a room next to another, making the shared wall two-sided", () => {
    const base = newRoomWithFloor(4, 4, D);
    const room = insertPath({ ...base, things: [base.things[0]!, { x: 512, y: 0 }] }, rectanglePoints(256, 0, 512, 256), true, D).room;
    expect(room.sectors).toHaveLength(2);
    const shared = room.linedefs.filter((l) => l.front && l.back);
    expect(shared).toHaveLength(1);
    // The old wall's texture moved to the step faces.
    expect(shared[0]!.front!.normal).toBe(0);
    expect(closed(room)).toEqual([]);
    compiles(room);
  });

  it("draws a polygon and a circle", () => {
    const poly = insertShape(newRoom(), polygonPoints(256, 256, 6, 128), D).room;
    expect(poly.linedefs).toHaveLength(6);
    expect(closed(poly)).toEqual([]);
    const circle = insertShape(newRoom(), polygonPoints(256, 256, circleSides(100), 100), D).room;
    expect(circle.linedefs.length).toBe(circleSides(100));
    expect(closed(circle)).toEqual([]);
    compiles(circle);
  });

  it("places a torch against a wall", () => {
    const base = newRoomWithFloor(4, 4, D);
    const { room, anchor } = insertTorch(base, 2, 128, 90);
    expect(anchor).toEqual([0, 128]);
    // The wall was split at the torch's base.
    expect(room.linedefs.length).toBe(4 + 1 + 4);
    const torch = room.linedefs.slice(-4);
    expect(torch.every((l) => l.front?.animateSpeed === 90 && l.back?.flags === 0x20f)).toBe(true);
    compiles(room);
  });
});

describe("roomedit operations", () => {
  const twoRooms = (): RoomSource =>
    insertPath(
      newRoomWithFloor(4, 4, D),
      [
        [0, 128],
        [256, 128],
      ],
      false,
      D,
    ).room;

  it("joins sectors by deleting the line between them", () => {
    const room = twoRooms();
    const cut = room.linedefs.findIndex((l) => l.front && l.back);
    const joined = deleteLinedefsJoinSectors(room, [cut]);
    expect(joined.sectors).toHaveLength(1);
    // The split walls stay split, still one sector.
    expect(closed(joined)).toEqual([]);
    compiles(joined);
  });

  it("merges sectors", () => {
    const merged = mergeSectors(twoRooms(), [0, 1]);
    expect(merged.sectors).toHaveLength(1);
    expect(merged.linedefs.filter((l) => l.front && l.back).every((l) => l.front!.sector === l.back!.sector)).toBe(true);
  });

  it("deletes a sector and the walls only it used", () => {
    const room = twoRooms();
    const out = deleteItems(room, "sector", [1]);
    expect(out.sectors).toHaveLength(1);
    expect(closed(out)).toEqual([]);
    expect(checkCrossReferences(out).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("joins linedefs through a vertex and merges vertices", () => {
    const room = splitLinedefs(newRoomWithFloor(4, 4, D), [0]).room;
    expect(room.linedefs).toHaveLength(5);
    const v = room.vertices.length - 1;
    const joined = deleteVertexJoinLinedefs(room, v);
    expect(joined.linedefs).toHaveLength(4);
    expect(closed(joined)).toEqual([]);
    const merged = mergeVertices(room, [v, room.linedefs[0]!.start]);
    expect(merged.vertices).toHaveLength(4);
  });

  it("flips and swaps linedefs", () => {
    const room = newRoomWithFloor(4, 4, D);
    expect(flipLinedefs(flipLinedefs(room, [0], true), [0], true).linedefs[0]).toEqual(room.linedefs[0]);
    expect(flipLinedefs(room, [0], false).linedefs[0]!.back).toEqual(room.linedefs[0]!.front);
  });

  it("makes a door between two rooms", () => {
    let room = newRoomWithFloor(6, 2, { ...D, ceilingHeight: 128 });
    room = insertPath(room, [[128, 0], [128, 128]], false, D).room;
    room = insertPath(room, [[256, 0], [256, 128]], false, D).room;
    const door = sectorAtPoint(room, 192, 64)!;
    const out = makeDoor(room, door);
    expect(out.sectors[door]!.ceilingHeight).toBe(out.sectors[door]!.floorHeight);
    expect(out.sectors[door]!.serverId).toBeGreaterThan(0);
    expect(out.linedefs.filter((l) => l.back?.sector === door && l.front && l.front.sector !== door)).toHaveLength(2);
    expect(closed(out)).toEqual([]);
  });

  it("distributes floor heights", () => {
    let room = newRoomWithFloor(6, 2, D);
    room = insertPath(room, [[128, 0], [128, 128]], false, D).room;
    room = insertPath(room, [[256, 0], [256, 128]], false, D).room;
    const order = [sectorAtPoint(room, 64, 64)!, sectorAtPoint(room, 192, 64)!, sectorAtPoint(room, 320, 64)!];
    room = { ...room, sectors: room.sectors.map((s, i) => (i === order[2] ? { ...s, floorHeight: 64 } : s)) };
    const out = distributeHeights(room, order, "floor");
    expect(order.map((s) => out.sectors[s]!.floorHeight)).toEqual([0, 32, 64]);
  });

  it("aligns x offsets around a loop", () => {
    const room = newRoomWithFloor(4, 4, D);
    const loop = loopFrom(room, 0);
    expect(loop).toHaveLength(4);
    const out = alignTexturesX(room, loop, { front: true, part: "normal", initialOffset: 0, textureWidth: () => 96 });
    expect(loop.map((i) => out.linedefs[i]!.front!.xOffset)).toEqual([0, 256 % 96, 512 % 96, 768 % 96]);
  });

  it("copies and pastes a sector", () => {
    const room = twoRooms();
    const clip = copySelection(room, "sector", [1]);
    const pasted = paste({ ...room, things: [room.things[0]!, { x: 1024, y: 0 }] }, clip, 512, 0);
    expect(pasted.room.sectors).toHaveLength(3);
    expect(pasted.kind).toBe("sector");
    expect(closed(pasted.room)).toEqual([]);
    compiles(pasted.room);
  });

  it("rotates and mirrors without breaking sectors", () => {
    const room = twoRooms();
    expect(closed(rotateScale(room, "sector", [0, 1], 90, 1))).toEqual([]);
    expect(closed(mirror(room, "sector", [0, 1], true))).toEqual([]);
  });

  it("auto-merges a vertex dropped on another, and splits a wall it lands on", () => {
    // Two rooms side by side with a gap: drag the right room's left wall onto the left room's right wall.
    let room = newRoomWithFloor(4, 4, D);
    room = insertPath({ ...room, things: [room.things[0]!, { x: 768, y: 0 }] }, rectanglePoints(320, 0, 576, 256), true, D).room;
    const right = [4, 5, 6, 7].filter((v) => room.vertices[v]![0] === 320);
    const moved = moveItems(room, "vertex", right, -64, 0);
    const merged = autoMerge(moved, right.map((v) => moved.vertices[v]!));
    expect(merged.vertices).toHaveLength(6);
    // The shared wall became one two-sided linedef.
    expect(merged.linedefs.filter((l) => l.front && l.back)).toHaveLength(1);
    expect(closed(merged)).toEqual([]);
    compiles(merged);
    // A lone vertex dropped on a wall splits it.
    const split = addVertex(newRoomWithFloor(4, 4, D), 0, 100);
    expect(split.room.linedefs).toHaveLength(5);
    expect(closed(split.room)).toEqual([]);
  });

  it("adds a slope on three of the sector's vertices", () => {
    const room = addSlope(newRoomWithFloor(4, 4, D), 0, true);
    expect(room.sectors[0]!.flags & 0x400).toBe(0x400);
    expect(room.sectors[0]!.floorSlope!.points).toHaveLength(3);
    compiles(room);
  });
});
