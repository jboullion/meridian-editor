// The walk mode's movement must be the client's: frame for frame the same as
// meridian-browser's PlayerMover (its move.c port) on shipped rooms, and it must
// stop where the game stops a player in the editor's test room.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { getProfile, readRoo } from "@meridian-editor/roo";
import { compileRoom, parseRoomSource } from "@meridian-editor/roomc";
import { toClientRoom } from "./clientRoom.ts";
import { Walker } from "./walker.ts";

const BROWSER = "E:/2026_Experiments/meridian-browser/packages";
const ROOMS = "E:/2026_Experiments/meridian-unreal/ReferenceServers/Server-104/resource/rooms";
const EDTEST = new URL("../../../../../rooms/new/edtest.room.json", import.meta.url);

/** The centre of Kod square (row, col), client units. */
const square = (row: number, col: number): [number, number] => [(col - 0.5) * 1024, (row - 0.5) * 1024];
const col = (w: Walker): number => 1 + w.x / 1024;
const row = (w: Walker): number => 1 + w.y / 1024;

/** Walk forward at `angle` for `ms`, then stand still a moment so climbing and falling finish. */
function walk(w: Walker, angle: number, ms: number): void {
  w.angle = angle;
  for (let t = 0; t < ms; t += 16) w.update({ forward: 1, strafe: 0, run: false }, 16);
  for (let t = 0; t < 1500; t += 16) w.update({ forward: 0, strafe: 0, run: false }, 16);
}

describe.skipIf(!existsSync(EDTEST))("walking the editor's test room", () => {
  let room: ReturnType<typeof toClientRoom> | undefined;
  const at = (r: number, c: number): Walker => {
    room ??= toClientRoom(compileRoom(parseRoomSource(readFileSync(EDTEST, "utf8")), getProfile("104")).file);
    const w = new Walker();
    w.room = room;
    w.place(...square(r, c));
    return w;
  };
  const EAST = 0;
  const WEST = 2048;
  const NORTH = 3072;

  it("steps up onto the platform and stops at the ledge", () => {
    const w = at(3, 2);
    walk(w, EAST, 600); // about 3.3 squares a second
    expect(col(w)).toBeGreaterThan(3);
    expect(col(w)).toBeLessThan(6);
    expect(w.z).toBe(16 * 16); // on the platform
    walk(w, EAST, 5000);
    expect(col(w)).toBeGreaterThan(10.5);
    expect(col(w)).toBeLessThan(11); // the ledge starts at column 11
    expect(w.z).toBe(0);
  });

  it("climbs the ramp onto the ledge", () => {
    const w = at(9, 10);
    walk(w, EAST, 900);
    expect(col(w)).toBeGreaterThan(12);
    expect(col(w)).toBeLessThan(15);
    expect(w.z).toBeGreaterThan(0); // on the ramp
    walk(w, NORTH, 1600);
    expect(row(w)).toBeLessThan(6); // the ledge is rows 2-5
    expect(w.z).toBe(64 * 16);
  });

  it("is stopped by the pillar and the low tunnel", () => {
    const pillar = at(7, 10);
    walk(pillar, WEST, 4000);
    expect(col(pillar)).toBeCloseTo(9, 0); // the pillar's east face is at column 9
    const tunnel = at(9, 7);
    walk(tunnel, WEST, 4000);
    expect(col(tunnel)).toBeGreaterThan(6); // the tunnel's mouth is at column 6
  });
});

describe.skipIf(!existsSync(join(BROWSER, "world/src/movement.ts")) || !existsSync(ROOMS))("against Shards' PlayerMover", () => {
  it("moves exactly like the client on shipped rooms", async () => {
    const { PlayerMover } = (await import(/* @vite-ignore */ pathToFileURL(join(BROWSER, "world/src/movement.ts")).href)) as {
      PlayerMover: new (sink: object) => {
        x: number;
        y: number;
        z: number;
        angle: number;
        room: unknown;
        place(x: number, y: number, now: number): void;
        update(input: object, dt: number, now: number, objects: unknown[], selfId: number): void;
      };
    };
    const { parseRoo } = (await import(/* @vite-ignore */ pathToFileURL(join(BROWSER, "formats/src/roo.ts")).href)) as { parseRoo: (b: Uint8Array) => unknown };
    const names = readdirSync(ROOMS)
      .filter((f) => f.endsWith(".roo"))
      .filter((_, i) => i % 15 === 0);
    let seed = 12345;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const mismatches: string[] = [];
    for (const name of names) {
      const bytes = new Uint8Array(readFileSync(join(ROOMS, name)));
      const ours = new Walker();
      ours.room = toClientRoom(readRoo(bytes));
      const theirs = new PlayerMover({ move() {}, turn() {} });
      theirs.room = parseRoo(bytes);
      // Start in the middle of the first leaf with a sector.
      const leaf = ours.room.nodes.find((n) => n.type === "leaf" && n.sector && n.points.length);
      if (!leaf || leaf.type !== "leaf") continue;
      const sx = Math.round(leaf.points.reduce((s, p) => s + p.x, 0) / leaf.points.length);
      const sy = Math.round(leaf.points.reduce((s, p) => s + p.y, 0) / leaf.points.length);
      ours.place(sx, sy);
      theirs.place(sx, sy, 0);
      let input = { forward: 1, strafe: 0, run: false };
      for (let f = 0; f < 900; f++) {
        if (f % 45 === 0) {
          const angle = Math.floor(rand() * 4096);
          ours.angle = theirs.angle = angle;
          input = { forward: rand() < 0.85 ? 1 : -1, strafe: rand() < 0.2 ? 1 : 0, run: rand() < 0.4 };
        }
        ours.update(input, 16);
        theirs.update(input, 16, f * 16 + 1, [], 0);
        if (ours.x !== theirs.x || ours.y !== theirs.y || ours.z !== theirs.z) {
          mismatches.push(`${name} frame ${f}: ours (${ours.x}, ${ours.y}, ${ours.z}), theirs (${theirs.x}, ${theirs.y}, ${theirs.z})`);
          break;
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
