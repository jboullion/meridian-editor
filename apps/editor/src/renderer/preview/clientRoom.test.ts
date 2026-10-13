// The preview's client room (from a RooFile) must match meridian-browser's
// parseRoo (from the bytes) exactly: wall heights, separators, bowties, slope
// axes. Skips when meridian-browser or the reference rooms aren't present.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { readRoo } from "@meridian-editor/roo";
import { toClientRoom } from "./clientRoom.ts";
import { buildRoomGeometry } from "./roomGeometry.ts";

const BROWSER_ROO = "E:/2026_Experiments/meridian-browser/packages/formats/src/roo.ts";
const ROOMS = "E:/2026_Experiments/meridian-unreal/ReferenceServers/Server-104/resource/rooms";
const available = existsSync(BROWSER_ROO) && existsSync(ROOMS);

describe.skipIf(!available)("client room adapter", () => {
  it("matches meridian-browser's parseRoo on shipped 104 rooms", async () => {
    const { parseRoo } = (await import(/* @vite-ignore */ pathToFileURL(BROWSER_ROO).href)) as {
      parseRoo: (b: Uint8Array) => {
        walls: Record<string, unknown>[];
        nodes: unknown[];
        thingsBox: unknown;
        sectors: Record<string, unknown>[];
      };
    };
    const names = readdirSync(ROOMS)
      .filter((f) => f.endsWith(".roo"))
      .filter((_, i) => i % 6 === 0);
    const failures: string[] = [];
    for (const name of names) {
      const bytes = new Uint8Array(readFileSync(join(ROOMS, name)));
      const theirs = parseRoo(bytes);
      const ours = toClientRoom(readRoo(bytes));
      const pick = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.map((k) => [k, o[k]]));
      const wallKeys = ["x0", "y0", "x1", "y1", "length", "z0", "z1", "z2", "z3", "zz0", "zz1", "zz2", "zz3", "z1Neg", "zz1Neg", "bowtie", "separator", "posXOffset", "posYOffset"];
      const sectorKeys = ["floorHeight", "ceilingHeight", "tx", "ty", "light", "slopedFloor", "slopedCeiling"];
      try {
        expect(ours.walls.map((w) => pick(w as unknown as Record<string, unknown>, wallKeys))).toEqual(theirs.walls.map((w) => pick(w, wallKeys)));
        expect(ours.sectors.map((s) => pick(s as unknown as Record<string, unknown>, sectorKeys))).toEqual(
          theirs.sectors.map((s) => {
            const p = pick(s, sectorKeys);
            // Theirs keeps the slope's plane under the same names; compare the parts both have.
            for (const k of ["slopedFloor", "slopedCeiling"]) if (p[k]) p[k] = { ...(p[k] as object) };
            return p;
          }),
        );
        // Node planes, children, boxes, wall lists and leaf points, as the client holds them.
        expect(ours.nodes).toEqual(theirs.nodes);
        expect(ours.thingsBox).toEqual(theirs.thingsBox);
      } catch (e) {
        failures.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it("builds geometry with finite coordinates for every shipped room sampled", () => {
    const names = readdirSync(ROOMS)
      .filter((f) => f.endsWith(".roo"))
      .filter((_, i) => i % 12 === 0);
    for (const name of names) {
      const room = toClientRoom(readRoo(new Uint8Array(readFileSync(join(ROOMS, name)))));
      const batches = buildRoomGeometry(room, () => ({ width: 64, height: 64, shrink: 1 }));
      let vertices = 0;
      for (const b of batches.values()) {
        vertices += b.positions.length / 3;
        expect(b.positions.every(Number.isFinite) && b.uvs.every(Number.isFinite)).toBe(true);
        expect(b.sectors.length * 3).toBe(b.positions.length);
      }
      expect(vertices).toBeGreaterThan(0);
    }
  });
});
