import { describe, expect, it } from "vitest";
import { checkRoo, computeSecurity, PROFILES, readRoo, SF, WF, writeRoo, type RooFile } from "../src/index.ts";

// A one-sector square room: a single leaf, no walls in the tree.
function tinyRoom(version: number): RooFile {
  // v12 stores these as i32.
  const f = (v: number): number => (version < 13 ? Math.round(v) : v);
  return {
    version,
    security: 0,
    width: 2048,
    height: 2048,
    nodes: [
      {
        type: "leaf",
        bbox: { x0: 0, y0: 0, x1: 2048, y1: 2048 },
        sector: 1,
        points: [
          { x: 0, y: 0 },
          { x: 2048, y: 0 },
          { x: 2048, y: 2048 },
          { x: 0, y: 2048 },
        ],
      },
    ],
    clientWalls: [],
    editorWalls: [
      { sidedef1: 1, sidedef2: 0, xOffset1: 0, xOffset2: 0, yOffset1: 0, yOffset2: 0, sector1: 0, sector2: -1, x0: 0, y0: 0, x1: 128, y1: 0 },
    ],
    sidedefs: [{ id: 0, normal: 100, above: 0, below: 0, flags: WF.PASSABLE, animateSpeed: 0 }],
    sectors: [
      {
        userId: 7,
        floorTexture: 1,
        ceilingTexture: 2,
        xOffset: 0,
        yOffset: 0,
        floorHeight: 0,
        ceilingHeight: 256,
        light: 192,
        flags: SF.SLOPED_FLOOR | 0x2000,
        animateSpeed: 0,
        floorSlope: {
          a: f(0.25),
          b: f(-1.5),
          c: f(1023.75),
          d: f(12.5),
          x: version === 13 ? 1.5 : 16,
          y: 32,
          angle: 1024,
          points: [
            { x: 0, y: 0, z: 0 },
            { x: 128, y: 0, z: 8 },
            { x: 0, y: -128, z: 0 },
          ],
        },
        ceilingSlope: null,
      },
    ],
    things: {
      format: "corners",
      things: [
        { x: 0, y: 0 },
        { x: 128, y: -128 },
      ],
    },
    roomId: 1234,
    server:
      version < 14
        ? { rows: 2, cols: 2, playerMove: Uint8Array.of(1, 2, 3, 4), squareFlags: Uint8Array.of(5, 6, 7, 8), monsterMove: Uint8Array.of(9, 10, 11, 12) }
        : null,
    serverExtra: new Uint8Array(0),
  };
}

describe("writeRoo / readRoo", () => {
  for (const version of [12, 13, 15]) {
    it(`round-trips a synthetic v${version} room`, () => {
      const room = tinyRoom(version);
      const bytes = writeRoo(room);
      const back = readRoo(bytes);
      expect(back).toEqual({ ...room, security: computeSecurity(room) });
      expect(writeRoo(back)).toEqual(bytes);
    });
  }

  it("keeps the undefined sector flag 0x2000", () => {
    const back = readRoo(writeRoo(tinyRoom(15)));
    expect(back.sectors[0]!.flags & 0x2000).toBe(0x2000);
  });

  it("writes an empty server section for v15, pointing at end of file", () => {
    const bytes = writeRoo(tinyRoom(15));
    const view = new DataView(bytes.buffer);
    expect(view.getInt32(12, true)).toBe(20);
    expect(view.getInt32(16, true)).toBe(bytes.byteLength);
  });

  it("rejects bad magic and unsupported versions", () => {
    const bytes = writeRoo(tinyRoom(15));
    const badMagic = bytes.slice();
    badMagic[0] = 0;
    expect(() => readRoo(badMagic)).toThrow(/magic/);
    const v16 = bytes.slice();
    new DataView(v16.buffer).setInt32(4, 16, true);
    expect(() => readRoo(v16)).toThrow(/version 16/);
  });
});

describe("computeSecurity", () => {
  it("includes float coordinates only for the original rule", () => {
    const v13 = tinyRoom(13);
    const moved13 = tinyRoom(13);
    (moved13.nodes[0] as { points: { x: number }[] }).points[1]!.x = 2047;
    expect(computeSecurity(moved13)).not.toBe(computeSecurity(v13));

    const v15 = tinyRoom(15);
    const moved15 = tinyRoom(15);
    (moved15.nodes[0] as { points: { x: number }[] }).points[1]!.x = 2047;
    expect(computeSecurity(moved15)).toBe(computeSecurity(v15));
  });

  it("adds heights as unsigned 16-bit values", () => {
    const room = tinyRoom(15);
    const lowered = tinyRoom(15);
    lowered.sectors[0]!.floorHeight = -1;
    // -1 as a WORD is 0xffff: 65535 more than 0.
    const expected = ((computeSecurity(room) ^ 0x89ab786c) + 0xffff) ^ 0x89ab786c;
    expect(computeSecurity(lowered)).toBe(expected | 0);
  });
});

describe("checkRoo", () => {
  const sealed = (room: RooFile): RooFile => ({ ...room, security: computeSecurity(room) });

  it("accepts the synthetic rooms on their own targets", () => {
    expect(checkRoo(sealed(tinyRoom(13)), PROFILES.original).filter((i) => i.severity === "error")).toEqual([]);
    expect(checkRoo(sealed(tinyRoom(15)), PROFILES["104"]).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("flags what 104 can't load", () => {
    const room = tinyRoom(15);
    room.sectors[0]!.floorHeight = -16;
    room.sidedefs[0]!.flags |= WF.NO_HTILE;
    room.things = { format: "corners", things: [{ x: 0, y: 0 }] };
    const errors = checkRoo(sealed(room), PROFILES["104"]).map((i) => i.message);
    expect(errors.some((m) => m.includes("negative height"))).toBe(true);
    expect(errors.some((m) => m.includes("wall flags"))).toBe(true);
    expect(errors.some((m) => m.includes("exactly 2"))).toBe(true);
  });

  it("flags a version from the other family", () => {
    const errors = checkRoo(sealed(tinyRoom(13)), PROFILES["104"]).map((i) => i.message);
    expect(errors.some((m) => m.includes("not loaded by the 104 target"))).toBe(true);
  });

  it("flags a stale checksum", () => {
    const errors = checkRoo({ ...tinyRoom(15), security: 1 }).map((i) => i.message);
    expect(errors.some((m) => m.includes("checksum"))).toBe(true);
  });
});
